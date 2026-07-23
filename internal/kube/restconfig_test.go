package kube

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"k8s.io/client-go/rest"

	"github.com/n0madic/kube-console/internal/config"
)

const multiContextKubeconfig = `apiVersion: v1
kind: Config
current-context: alpha
clusters:
- name: alpha-cluster
  cluster:
    server: https://alpha.example:6443
- name: beta-cluster
  cluster:
    server: https://beta.example:6443
contexts:
- name: alpha
  context:
    cluster: alpha-cluster
    user: alpha-user
- name: beta
  context:
    cluster: beta-cluster
    user: beta-user
users:
- name: alpha-user
  user:
    token: alpha-secret-token
- name: beta-user
  user:
    token: beta-secret-token
`

const envOnlyKubeconfig = `apiVersion: v1
kind: Config
current-context: env
clusters:
- name: env-cluster
  cluster:
    server: https://env-only.example:6443
contexts:
- name: env
  context:
    cluster: env-cluster
    user: env-user
users:
- name: env-user
  user:
    token: env-secret-token
`

func writeFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "kubeconfig")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeKubeconfig(t *testing.T) string {
	t.Helper()
	return writeFile(t, multiContextKubeconfig)
}

// configsByName indexes RESTConfigs output for assertions and checks the
// zero-credential invariant on every entry.
func configsByName(t *testing.T, configs []NamedConfig) map[string]*rest.Config {
	t.Helper()
	m := map[string]*rest.Config{}
	for _, nc := range configs {
		if nc.Config.BearerToken != "" {
			t.Errorf("context %q leaked a bearer token: %q", nc.Name, nc.Config.BearerToken)
		}
		m[nc.Name] = nc.Config
	}
	return m
}

func TestRESTConfigsEnumeratesContexts(t *testing.T) {
	configs, defaultName, err := RESTConfigs(&config.Config{Kubeconfig: writeKubeconfig(t)})
	if err != nil {
		t.Fatal(err)
	}
	if defaultName != "alpha" {
		t.Errorf("defaultName = %q, want current-context (alpha)", defaultName)
	}
	byName := configsByName(t, configs)
	if len(byName) != 2 {
		t.Fatalf("got %d contexts, want alpha+beta", len(byName))
	}
	if byName["alpha"].Host != "https://alpha.example:6443" {
		t.Errorf("alpha Host = %q", byName["alpha"].Host)
	}
	if byName["beta"].Host != "https://beta.example:6443" {
		t.Errorf("beta Host = %q", byName["beta"].Host)
	}
}

func TestRESTConfigsSelectsDefaultContext(t *testing.T) {
	_, defaultName, err := RESTConfigs(&config.Config{
		Kubeconfig:  writeKubeconfig(t),
		KubeContext: "beta",
	})
	if err != nil {
		t.Fatal(err)
	}
	if defaultName != "beta" {
		t.Errorf("defaultName = %q, want beta", defaultName)
	}
}

func TestRESTConfigsUnknownContext(t *testing.T) {
	_, _, err := RESTConfigs(&config.Config{
		Kubeconfig:  writeKubeconfig(t),
		KubeContext: "does-not-exist",
	})
	if err == nil {
		t.Fatal("expected error for unknown context")
	}
}

func TestRESTConfigsFromKUBECONFIGEnv(t *testing.T) {
	t.Setenv("KUBECONFIG", writeKubeconfig(t))
	configs, defaultName, err := RESTConfigs(&config.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if defaultName != "alpha" {
		t.Errorf("defaultName = %q, want alpha from $KUBECONFIG", defaultName)
	}
	if byName := configsByName(t, configs); byName["alpha"].Host != "https://alpha.example:6443" {
		t.Errorf("alpha Host = %q", byName["alpha"].Host)
	}
}

func TestRESTConfigsExplicitPathOverridesEnv(t *testing.T) {
	t.Setenv("KUBECONFIG", writeFile(t, envOnlyKubeconfig))
	configs, _, err := RESTConfigs(&config.Config{Kubeconfig: writeKubeconfig(t)})
	if err != nil {
		t.Fatal(err)
	}
	byName := configsByName(t, configs)
	if _, ok := byName["alpha"]; !ok {
		t.Error("explicit --kubeconfig must override $KUBECONFIG (want alpha context)")
	}
	if _, ok := byName["env"]; ok {
		t.Error("env-only context must not appear when --kubeconfig is explicit")
	}
}

func TestRESTConfigsAPIServer(t *testing.T) {
	configs, defaultName, err := RESTConfigs(&config.Config{KubeAPIServer: "https://explicit.example:6443"})
	if err != nil {
		t.Fatal(err)
	}
	if defaultName != "default" {
		t.Errorf("defaultName = %q, want default for api-server mode", defaultName)
	}
	byName := configsByName(t, configs)
	if len(byName) != 1 || byName["default"].Host != "https://explicit.example:6443" {
		t.Errorf("api-server mode = %+v, want single 'default'", byName)
	}
}

func TestRESTConfigsAPIServerNamedByContext(t *testing.T) {
	_, defaultName, err := RESTConfigs(&config.Config{
		KubeAPIServer: "https://explicit.example:6443",
		KubeContext:   "prod",
	})
	if err != nil {
		t.Fatal(err)
	}
	if defaultName != "prod" {
		t.Errorf("defaultName = %q, want the --context name (prod)", defaultName)
	}
}

func TestRESTConfigsAPIServerWinsOverKubeconfig(t *testing.T) {
	configs, _, err := RESTConfigs(&config.Config{
		KubeAPIServer: "https://explicit.example:6443",
		Kubeconfig:    writeKubeconfig(t),
	})
	if err != nil {
		t.Fatal(err)
	}
	byName := configsByName(t, configs)
	if len(byName) != 1 || byName["default"].Host != "https://explicit.example:6443" {
		t.Errorf("explicit --api-server must win over --kubeconfig, got %+v", byName)
	}
}

func TestRESTConfigsAPIServerIgnoresKUBECONFIGEnv(t *testing.T) {
	t.Setenv("KUBECONFIG", writeFile(t, envOnlyKubeconfig))
	configs, _, err := RESTConfigs(&config.Config{KubeAPIServer: "https://explicit.example:6443"})
	if err != nil {
		t.Fatal(err)
	}
	if byName := configsByName(t, configs); byName["default"].Host != "https://explicit.example:6443" {
		t.Errorf("explicit --api-server must win over $KUBECONFIG, got %+v", byName)
	}
}

func TestRESTConfigsNoConfigFound(t *testing.T) {
	t.Setenv("KUBECONFIG", filepath.Join(t.TempDir(), "does-not-exist"))
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	_, _, err := RESTConfigs(&config.Config{})
	if err == nil {
		t.Fatal("expected error when no kubeconfig resolves")
	}
	if !strings.Contains(err.Error(), "no kubeconfig found") {
		t.Errorf("error = %q, want a 'no kubeconfig found' hint", err.Error())
	}
}

func TestValidContextName(t *testing.T) {
	valid := []string{
		"alpha",
		"arn:aws:eks:us-east-1:123456789012:cluster/prod",
		"user@cluster.example.com",
		strings.Repeat("x", 253),
	}
	for _, name := range valid {
		if !ValidContextName(name) {
			t.Errorf("ValidContextName(%q) = false, want true", name)
		}
	}
	invalid := []string{
		"",
		strings.Repeat("x", 254),
		"tab\tname",
		"emoji-☃",
	}
	for _, name := range invalid {
		if ValidContextName(name) {
			t.Errorf("ValidContextName(%q) = true, want false", name)
		}
	}
}

// A kubeconfig whose server URL embeds basic-auth credentials, plus an
// authenticated egress proxy. AnonymousClientConfig copies both verbatim.
const credentialsInURLKubeconfig = `apiVersion: v1
kind: Config
current-context: leaky
clusters:
- name: leaky-cluster
  cluster:
    server: https://url-user:url-secret-password@leaky.example:6443
    proxy-url: http://proxy-user:proxy-secret-password@proxy.example:3128
contexts:
- name: leaky
  context:
    cluster: leaky-cluster
    user: leaky-user
users:
- name: leaky-user
  user:
    token: leaky-secret-token
`

// captureDefaultLogs redirects slog.Default() into a buffer for the test.
func captureDefaultLogs(t *testing.T) *strings.Builder {
	t.Helper()
	var buf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

func TestRESTConfigsStripsCredentialsFromKubeconfigServerURL(t *testing.T) {
	logs := captureDefaultLogs(t)
	configs, _, err := RESTConfigs(&config.Config{
		Kubeconfig: writeFile(t, credentialsInURLKubeconfig),
	})
	if err != nil {
		t.Fatal(err)
	}
	rc := configsByName(t, configs)["leaky"]
	if rc == nil {
		t.Fatal("leaky context missing")
	}
	if rc.Host != "https://leaky.example:6443" {
		t.Errorf("Host = %q, want the URL without userinfo", rc.Host)
	}
	if strings.Contains(logs.String(), "url-secret-password") {
		t.Errorf("startup log leaked the URL password: %q", logs.String())
	}
	if !strings.Contains(logs.String(), "stripped credentials") {
		t.Errorf("stripping must be reported, got %q", logs.String())
	}
	// proxy-url credentials are operator infrastructure credentials for the
	// CONNECT hop, never sent to the apiserver: kept, but never logged.
	if rc.Proxy == nil {
		t.Error("proxy-url must survive anonymization")
	}
	if strings.Contains(logs.String(), "proxy-secret-password") {
		t.Errorf("startup log leaked the proxy password: %q", logs.String())
	}
}

func TestRESTConfigsStripsCredentialsFromAPIServerFlag(t *testing.T) {
	logs := captureDefaultLogs(t)
	configs, _, err := RESTConfigs(&config.Config{
		KubeAPIServer: "https://url-user:url-secret-password@explicit.example:6443",
	})
	if err != nil {
		t.Fatal(err)
	}
	rc := configsByName(t, configs)["default"]
	if rc == nil {
		t.Fatal("default context missing")
	}
	if rc.Host != "https://explicit.example:6443" {
		t.Errorf("Host = %q, want the URL without userinfo", rc.Host)
	}
	if strings.Contains(logs.String(), "url-secret-password") {
		t.Errorf("startup log leaked the URL password: %q", logs.String())
	}
}

func TestNewUpstreamDropsHostCredentials(t *testing.T) {
	// Defense in depth: a config built outside RESTConfigs must still yield a
	// credential-free BaseURL (it is proxied to, probed and printed).
	up, err := NewUpstream(&rest.Config{Host: "https://url-user:url-secret-password@leaky.example:6443"})
	if err != nil {
		t.Fatal(err)
	}
	if up.BaseURL.String() != "https://leaky.example:6443" {
		t.Errorf("BaseURL = %q, want no userinfo", up.BaseURL.String())
	}
	if up.BaseURL.User != nil {
		t.Errorf("BaseURL.User = %v, want nil", up.BaseURL.User)
	}
}

func TestParseHostErrorKeepsCredentialsOut(t *testing.T) {
	// url.Error stringifies the URL it failed on; the raw host must never be
	// echoed back, or a malformed server URL puts its password in the error.
	_, err := parseHost("https://url-user:url-secret-password@leaky.example:6443/\x7f\x00")
	if err == nil {
		t.Fatal("expected a parse error")
	}
	if strings.Contains(err.Error(), "url-secret-password") {
		t.Errorf("error leaked the password: %q", err.Error())
	}
}
