// Package kube provides the shared credential-free connection to the
// kube-apiserver and request-scoped bearer-token plumbing. Nothing in this
// package ever stores a user token beyond the lifetime of a single request or
// WebSocket connection.
package kube

import (
	"fmt"
	"log/slog"
	"sort"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/n0madic/kube-console/internal/config"
)

// NamedConfig pairs a kubeconfig context name with its credential-free
// rest.Config. The name is the key clients use to select an upstream; the
// config carries only Host/CA — credentials are always stripped.
type NamedConfig struct {
	Name   string
	Config *rest.Config
	// UseCredentials reports that this config kept its kubeconfig credentials
	// (the --use-kubeconfig-credentials carve-out). It states what RESTConfigs
	// actually did rather than what was asked for: the carve-out applies to the
	// kubeconfig branch only, so a caller re-reading the flag instead would mark
	// an anonymized --api-server upstream as credentialed and produce an
	// upstream that authenticates with nothing at all.
	UseCredentials bool
}

// RESTConfigs enumerates the credential-free rest.Configs for every reachable
// upstream and reports which one is the default. Multi-cluster is only
// meaningful for kubeconfig discovery; an explicit --api-server or in-cluster
// deployment yields a single context (named after --context or "default").
//
// In every case credentials are stripped via rest.AnonymousClientConfig plus
// stripHostCredentials (which covers what AnonymousClientConfig copies
// verbatim), so the zero-credential invariant holds regardless of source. The
// single exception is cfg.UseKubeconfigCredentials, the local-development
// carve-out, which swaps anonymize for keepUserCredentials on the kubeconfig
// branch only — see keepUserCredentials.
//
// An explicit api-server always wins, even when a kubeconfig is also set: the
// precedence must match config.applyInClusterDefaults and the README so the
// user's bearer token is forwarded only to the operator's chosen apiserver,
// never silently rerouted to a cluster from a stray KUBE_CONSOLE_KUBECONFIG in
// the environment.
func RESTConfigs(cfg *config.Config) (configs []NamedConfig, defaultName string, err error) {
	if cfg.KubeAPIServer != "" {
		name := cfg.KubeContext
		if name == "" {
			name = "default"
		}
		rc := &rest.Config{
			Host: cfg.KubeAPIServer,
			TLSClientConfig: rest.TLSClientConfig{
				CAFile: cfg.KubeCAFile,
			},
		}
		// AnonymousClientConfig is a no-op here but guarantees the invariant even
		// if config construction changes later. --api-server is operator input,
		// so it can carry userinfo just like a kubeconfig server URL. This branch
		// is unconditionally anonymized: it holds no credentials to keep, and
		// config.validate has already rejected --use-kubeconfig-credentials here.
		return []NamedConfig{{Name: name, Config: anonymize(rc, name)}}, name, nil
	}

	// The one place the carve-out changes what happens to a config. Chosen once
	// so every context of this kubeconfig is treated identically, and reported
	// on every NamedConfig so no caller has to re-derive it from the flag.
	prepare, keptCredentials := anonymize, false
	if cfg.UseKubeconfigCredentials {
		prepare, keptCredentials = keepUserCredentials, true
	}

	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	if cfg.Kubeconfig != "" {
		// An explicit path wins over $KUBECONFIG / ~/.kube/config.
		loadingRules.ExplicitPath = cfg.Kubeconfig
	}
	// A single RawConfig() read exposes every context; per-context configs are
	// derived from it below. Empty overrides keep each context's own cluster/user.
	raw, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		loadingRules, &clientcmd.ConfigOverrides{}).RawConfig()
	if err != nil {
		if clientcmd.IsEmptyConfig(err) {
			return nil, "", errNoKubeconfig()
		}
		return nil, "", fmt.Errorf("load kubeconfig: %w", err)
	}
	if len(raw.Contexts) == 0 {
		return nil, "", errNoKubeconfig()
	}

	defaultName = cfg.KubeContext
	if defaultName == "" {
		defaultName = raw.CurrentContext
	}
	if defaultName == "" {
		return nil, "", fmt.Errorf("kubeconfig has no current-context; set --context to choose one")
	}
	if _, ok := raw.Contexts[defaultName]; !ok {
		return nil, "", fmt.Errorf("context %q not found in kubeconfig", defaultName)
	}

	// Deterministic, stable ordering for the context switcher.
	names := make([]string, 0, len(raw.Contexts))
	for name := range raw.Contexts {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		if !ValidContextName(name) {
			// EKS ARNs and user@cluster names are valid; warn but keep — the
			// registry stays authoritative on which names resolve.
			slog.Default().Warn("kubeconfig context name has unusual characters", "context", name)
		}
		clientConfig := clientcmd.NewNonInteractiveClientConfig(raw, name, &clientcmd.ConfigOverrides{}, loadingRules)
		rc, cErr := clientConfig.ClientConfig()
		if cErr != nil {
			if name == defaultName {
				return nil, "", fmt.Errorf("load kubeconfig context %q: %w", name, cErr)
			}
			// A single broken non-default context must not sink the others.
			slog.Default().Warn("skipping unusable kubeconfig context", "context", name, "error", cErr)
			continue
		}
		configs = append(configs, NamedConfig{
			Name:           name,
			Config:         prepare(rc, name),
			UseCredentials: keptCredentials,
		})
	}
	if len(configs) == 0 {
		return nil, "", fmt.Errorf("no usable kubeconfig contexts")
	}
	return configs, defaultName, nil
}

// anonymize is the single point where an upstream config loses its
// credentials: rest.AnonymousClientConfig for the fields it knows about, plus
// stripHostCredentials for the Host it copies verbatim.
func anonymize(rc *rest.Config, context string) *rest.Config {
	anon := rest.AnonymousClientConfig(rc)
	if stripHostCredentials(anon) {
		slog.Default().Warn("stripped credentials embedded in the apiserver URL", "context", context)
	}
	return anon
}

// keepUserCredentials is the only preparator that lets an upstream config keep
// its credentials — the --use-kubeconfig-credentials carve-out, reachable from
// the kubeconfig branch alone. Whatever the context authenticates with (bearer
// token, bearer token file, client certificate, an exec plugin such as `aws eks
// get-token`) rides along untouched: rest.TransportFor already understands all
// of them, so no per-mechanism code is needed here.
//
// Userinfo in the server URL is dropped even here, for reasons that are not
// about the invariant: client-go turns it into an `Authorization: Basic` header
// and its own bearer round tripper then refuses to overwrite that, so the URL's
// credentials would go upstream *instead of* the context's own — and this same
// URL is what gets printed at startup.
func keepUserCredentials(rc *rest.Config, context string) *rest.Config {
	kept := rest.CopyConfig(rc)
	if stripHostCredentials(kept) {
		slog.Default().Warn("stripped credentials embedded in the apiserver URL", "context", context)
	}
	return kept
}

// stripHostCredentials removes userinfo (user:password@) from a rest.Config
// Host, reporting whether it removed anything.
//
// rest.AnonymousClientConfig drops BearerToken/Username/Password/client certs
// but copies Host verbatim, so `server: https://user:pass@apiserver` survives
// it — and not just cosmetically: client-go's http.Client turns URL userinfo
// into an `Authorization: Basic` header, and its bearer round tripper declines
// to overwrite an Authorization header that is already set, so the operator's
// credentials would go upstream *instead of* the user's token (exec builds its
// URL straight from Host). The same URL is printed at startup. Both break the
// zero-credential invariant, so the userinfo is dropped where every upstream
// config is built.
//
// A kubeconfig `proxy-url` may carry userinfo too; that one is deliberately
// kept (rest.Config.Proxy survives AnonymousClientConfig). It authenticates
// kube-console to the operator's egress proxy, is never sent to the apiserver
// (net/http puts it in Proxy-Authorization on the CONNECT hop only), never
// reaches a client, and is never logged — BaseURL, the only URL printed, is
// built from Host alone.
func stripHostCredentials(rc *rest.Config) bool {
	if rc.Host == "" {
		return false
	}
	// A Host that does not parse is rejected later by parseHost, which keeps
	// the raw value out of its error.
	u, err := parseHostURL(rc.Host)
	if err != nil || u.User == nil {
		return false
	}
	u.User = nil
	rc.Host = u.String()
	return true
}

func errNoKubeconfig() error {
	return fmt.Errorf("no kubeconfig found: set --api-server, --kubeconfig, or KUBECONFIG (or create ~/.kube/config)")
}

// ValidContextName reports whether name fits the shared context-name charset:
// non-empty printable ASCII (0x20–0x7E), at most 253 bytes. It is used by the
// exec auth-frame validator and the registry warning; the registry's Resolve
// stays authoritative on which names actually route.
func ValidContextName(name string) bool {
	if len(name) == 0 || len(name) > 253 {
		return false
	}
	for i := 0; i < len(name); i++ {
		if name[i] < 0x20 || name[i] > 0x7E {
			return false
		}
	}
	return true
}
