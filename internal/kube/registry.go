package kube

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"

	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/httpx"
)

// ContextHeader carries the selected kubeconfig context name on inbound
// requests. It is only ever a key into the upstream registry — never
// interpolated into an upstream URL — and is stripped by the gateway's
// SanitizeHeaders before any request reaches the apiserver.
const ContextHeader = "X-Kube-Context"

// ErrUnknownContext is returned by Resolve for a non-empty context name that
// has no registered upstream. Callers translate it into a 400 before any
// upstream call is made.
var ErrUnknownContext = errors.New("unknown context")

// UnknownContextMessage is the canonical 400 body message for a rejected
// X-Kube-Context value. The frontend matches this exact string to trigger its
// reset-to-default recovery (web/src/api/http.ts), so it must not be reworded
// in only one place.
const UnknownContextMessage = "unknown cluster context"

// Registry holds one credential-free Upstream per kubeconfig context. Each
// context's rest.Config is wrapped in rest.AnonymousClientConfig, so the
// zero-credential invariant holds for every cluster. It is built once at
// startup and never mutated afterwards.
type Registry struct {
	names  []string
	byName map[string]*Upstream
	def    string
	// useConfigCreds mirrors config.UseKubeconfigCredentials. It is global, not
	// per-context: the carve-out is a property of how the process was started,
	// and every context of that kubeconfig is treated the same way.
	useConfigCreds bool
}

// NewRegistry enumerates every reachable upstream and builds the shared
// credential-free transport for each. It replaces the former single
// NewRESTConfig/NewUpstream pair.
func NewRegistry(cfg *config.Config) (*Registry, error) {
	configs, defaultName, err := RESTConfigs(cfg)
	if err != nil {
		return nil, err
	}
	reg := &Registry{
		byName: make(map[string]*Upstream, len(configs)),
		def:    defaultName,
	}
	for _, nc := range configs {
		up, err := NewUpstream(nc.Config)
		if err != nil {
			// Same policy as RESTConfigs: a broken non-default context (e.g. a
			// missing CA file, only read here by TransportFor) must not sink the
			// others; a broken default is a hard error.
			if nc.Name == defaultName {
				return nil, fmt.Errorf("build upstream for default context %q: %w", nc.Name, err)
			}
			slog.Default().Warn("skipping unusable kubeconfig context", "context", nc.Name, "error", err)
			continue
		}
		// From what RESTConfigs prepared, never from the flag: only the
		// kubeconfig branch keeps credentials, and an anonymized upstream marked
		// as credentialed would authenticate with nothing at all.
		up.UseConfigCredentials = nc.UseCredentials
		reg.names = append(reg.names, nc.Name)
		reg.byName[nc.Name] = up
	}
	def, ok := reg.byName[defaultName]
	if !ok {
		return nil, fmt.Errorf("default context %q has no usable upstream", defaultName)
	}
	reg.useConfigCreds = def.UseConfigCredentials
	return reg, nil
}

// NewRegistryFromUpstreams builds a registry from already-constructed
// upstreams (context name → upstream), with a stable, sorted name order. It is
// used wherever upstreams are resolved outside NewRegistry — notably tests that
// wire fake httptest upstreams. defaultName must be present in the map.
//
// The credential mode is read off the default upstream rather than taken as a
// parameter: it is a process-wide property that NewRegistry stamps on every
// upstream alike, and threading it through would only add an argument every
// existing caller passes as false.
func NewRegistryFromUpstreams(defaultName string, upstreams map[string]*Upstream) *Registry {
	reg := &Registry{byName: make(map[string]*Upstream, len(upstreams)), def: defaultName}
	if def, ok := upstreams[defaultName]; ok && def != nil {
		reg.useConfigCreds = def.UseConfigCredentials
	}
	for name := range upstreams {
		reg.names = append(reg.names, name)
	}
	sort.Strings(reg.names)
	for name, up := range upstreams {
		reg.byName[name] = up
	}
	return reg
}

// UsesConfigCredentials reports whether upstream requests authenticate with the
// kubeconfig's own credentials instead of a per-request user bearer token.
func (r *Registry) UsesConfigCredentials() bool { return r.useConfigCreds }

// Names returns the context names in stable order.
func (r *Registry) Names() []string { return r.names }

// DefaultName returns the resolved default context name.
func (r *Registry) DefaultName() string { return r.def }

// Default returns the default context's upstream.
func (r *Registry) Default() *Upstream { return r.byName[r.def] }

// Get returns the upstream for an exact context name.
func (r *Registry) Get(name string) (*Upstream, bool) {
	up, ok := r.byName[name]
	return up, ok
}

// Resolve maps a context-header value to an upstream. An empty value selects
// the default; an unknown non-empty value returns ErrUnknownContext. The
// returned name is the resolved context (the default's name for an empty
// value), which callers echo back to the frontend on first login.
func (r *Registry) Resolve(name string) (*Upstream, string, error) {
	if name == "" {
		// The default goes through the same lookup as any other name rather
		// than being returned unchecked: a registry whose default has no
		// upstream (NewRegistry rejects that, NewRegistryFromUpstreams only
		// documents it) would otherwise hand every caller a nil *Upstream with
		// a nil error, and the first BaseURL dereference panics into a 500
		// instead of failing closed with the 400 an unresolvable context gets.
		name = r.def
	}
	up, ok := r.byName[name]
	if !ok {
		return nil, "", ErrUnknownContext
	}
	return up, name, nil
}

// ResolveRequest resolves the request's X-Kube-Context header, writing the
// canonical 400 for an unknown name. It is the single chokepoint every HTTP
// handler uses, so the fail-closed semantics and the message the frontend
// matches on cannot drift between adapters. The boolean reports success.
func (r *Registry) ResolveRequest(w http.ResponseWriter, req *http.Request) (*Upstream, string, bool) {
	up, name, err := r.Resolve(req.Header.Get(ContextHeader))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "BadRequest", UnknownContextMessage)
		return nil, "", false
	}
	return up, name, true
}

// RequireToken returns the inbound bearer token, writing the canonical 401 when
// it is missing. Like ResolveRequest it is a single chokepoint: the same three
// lines used to be copied into every gated handler, and all of them have to
// agree about what an absent token means.
//
// In use-kubeconfig-credentials mode there is no user token at all, so it
// returns ("", true) and callers hand that empty string down to Do /
// Upstream.RoundTripper, which then authenticate with the kubeconfig's own
// credentials.
func (r *Registry) RequireToken(w http.ResponseWriter, req *http.Request) (string, bool) {
	if r.useConfigCreds {
		return "", true
	}
	token := ExtractBearer(req)
	if token == "" {
		httpx.WriteError(w, http.StatusUnauthorized, "Unauthorized", "missing bearer token")
		return "", false
	}
	return token, true
}
