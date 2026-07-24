package kube

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/n0madic/kube-console/internal/config"
)

func TestNewRegistryEnumeratesAndResolves(t *testing.T) {
	reg, err := NewRegistry(&config.Config{Kubeconfig: writeKubeconfig(t)})
	if err != nil {
		t.Fatal(err)
	}
	if reg.DefaultName() != "alpha" {
		t.Errorf("DefaultName = %q, want alpha", reg.DefaultName())
	}
	if names := reg.Names(); len(names) != 2 {
		t.Errorf("Names = %v, want alpha+beta", names)
	}

	// Empty header → default (alpha), resolved name reported.
	up, name, err := reg.Resolve("")
	if err != nil {
		t.Fatal(err)
	}
	if name != "alpha" || up != reg.Default() {
		t.Errorf("Resolve(\"\") = %q/%p, want alpha default", name, up)
	}
	if up.BaseURL.String() != "https://alpha.example:6443" {
		t.Errorf("default upstream host = %q", up.BaseURL.String())
	}
	if up.RestConfig.BearerToken != "" {
		t.Errorf("default upstream leaked a bearer token")
	}

	// Explicit beta.
	betaUp, betaName, err := reg.Resolve("beta")
	if err != nil {
		t.Fatal(err)
	}
	if betaName != "beta" || betaUp.BaseURL.String() != "https://beta.example:6443" {
		t.Errorf("Resolve(beta) = %q/%q", betaName, betaUp.BaseURL.String())
	}
	if betaUp.RestConfig.BearerToken != "" {
		t.Errorf("beta upstream leaked a bearer token")
	}

	// Unknown → ErrUnknownContext, no upstream.
	if _, _, err := reg.Resolve("nope"); !errors.Is(err, ErrUnknownContext) {
		t.Errorf("Resolve(nope) err = %v, want ErrUnknownContext", err)
	}
}

func TestNewRegistrySelectsDefaultContext(t *testing.T) {
	reg, err := NewRegistry(&config.Config{Kubeconfig: writeKubeconfig(t), KubeContext: "beta"})
	if err != nil {
		t.Fatal(err)
	}
	if reg.DefaultName() != "beta" {
		t.Errorf("DefaultName = %q, want beta", reg.DefaultName())
	}
	_, name, err := reg.Resolve("")
	if err != nil || name != "beta" {
		t.Errorf("Resolve(\"\") = %q, %v, want beta", name, err)
	}
}

func TestNewRegistryAPIServerSingleContext(t *testing.T) {
	reg, err := NewRegistry(&config.Config{KubeAPIServer: "https://explicit.example:6443"})
	if err != nil {
		t.Fatal(err)
	}
	if names := reg.Names(); len(names) != 1 || names[0] != "default" {
		t.Errorf("Names = %v, want single 'default'", names)
	}
	if reg.DefaultName() != "default" {
		t.Errorf("DefaultName = %q, want default", reg.DefaultName())
	}
}

func TestNewRegistryUnknownContext(t *testing.T) {
	_, err := NewRegistry(&config.Config{Kubeconfig: writeKubeconfig(t), KubeContext: "ghost"})
	if err == nil {
		t.Fatal("expected error for unknown --context")
	}
}

// brokenCAKubeconfig has a healthy alpha (current-context) plus a gamma
// context whose CA file does not exist. RESTConfigs keeps gamma (ClientConfig
// records the CA path without reading it); only NewUpstream's TransportFor
// loads the file and fails.
const brokenCAKubeconfig = `apiVersion: v1
kind: Config
current-context: alpha
clusters:
- name: alpha-cluster
  cluster:
    server: https://alpha.example:6443
- name: gamma-cluster
  cluster:
    server: https://gamma.example:6443
    certificate-authority: /does/not/exist/ca.crt
contexts:
- name: alpha
  context:
    cluster: alpha-cluster
    user: alpha-user
- name: gamma
  context:
    cluster: gamma-cluster
    user: gamma-user
users:
- name: alpha-user
  user:
    token: alpha-secret-token
- name: gamma-user
  user:
    token: gamma-secret-token
`

// Regression: a broken non-default context (unreadable CA file, surfaced only
// at NewUpstream) must be warned + skipped, not sink the whole server.
func TestNewRegistrySkipsBrokenNonDefaultUpstream(t *testing.T) {
	reg, err := NewRegistry(&config.Config{Kubeconfig: writeFile(t, brokenCAKubeconfig)})
	if err != nil {
		t.Fatalf("broken non-default context must be skipped, got error: %v", err)
	}
	if names := reg.Names(); len(names) != 1 || names[0] != "alpha" {
		t.Errorf("Names = %v, want gamma skipped (alpha only)", names)
	}
	if _, _, err := reg.Resolve("gamma"); !errors.Is(err, ErrUnknownContext) {
		t.Errorf("Resolve(gamma) err = %v, want ErrUnknownContext for the skipped context", err)
	}
}

// A broken default context stays a hard error.
func TestNewRegistryBrokenDefaultUpstreamFails(t *testing.T) {
	_, err := NewRegistry(&config.Config{Kubeconfig: writeFile(t, brokenCAKubeconfig), KubeContext: "gamma"})
	if err == nil {
		t.Fatal("expected error when the default context's upstream cannot be built")
	}
}

// RequireToken is the shared gate every adapter now uses, so both of its
// answers are load-bearing: a 401 in the normal mode, and a free pass with an
// empty token in the credential carve-out.
func TestRegistryRequireToken(t *testing.T) {
	reg, err := NewRegistry(&config.Config{Kubeconfig: writeKubeconfig(t)})
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	if _, ok := reg.RequireToken(rec, httptest.NewRequest(http.MethodGet, "/k8s/api", nil)); ok {
		t.Error("a request with no Authorization header must be rejected")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/k8s/api", nil)
	req.Header.Set("Authorization", "Bearer user-token")
	rec = httptest.NewRecorder()
	token, ok := reg.RequireToken(rec, req)
	if !ok || token != "user-token" {
		t.Errorf("RequireToken = %q, %v; want the inbound bearer", token, ok)
	}
}

func TestRegistryRequireTokenWithConfigCredentials(t *testing.T) {
	reg, err := NewRegistry(&config.Config{
		Kubeconfig:               writeKubeconfig(t),
		UseKubeconfigCredentials: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reg.UsesConfigCredentials() {
		t.Fatal("UsesConfigCredentials = false, want true")
	}
	for _, up := range []*Upstream{reg.Default(), mustGet(t, reg, "beta")} {
		if !up.UseConfigCredentials {
			t.Error("every upstream must be marked as carrying its own credentials")
		}
	}

	rec := httptest.NewRecorder()
	token, ok := reg.RequireToken(rec, httptest.NewRequest(http.MethodGet, "/k8s/api", nil))
	if !ok || token != "" {
		t.Errorf("RequireToken = %q, %v; want (\"\", true) with no user token", token, ok)
	}
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Errorf("nothing must be written: status %d, body %q", rec.Code, rec.Body.String())
	}
}

// RoundTripper is the chokepoint the two modes meet at.
func TestUpstreamRoundTripper(t *testing.T) {
	plain := &Upstream{Transport: http.DefaultTransport}
	if plain.RoundTripper("user-token") == http.RoundTripper(http.DefaultTransport) {
		t.Error("the default mode must wrap the shared transport with the bearer")
	}
	credentialed := &Upstream{Transport: http.DefaultTransport, UseConfigCredentials: true}
	if credentialed.RoundTripper("") != http.RoundTripper(http.DefaultTransport) {
		t.Error("the carve-out must use the credentialed transport as it is")
	}
}

func mustGet(t *testing.T, reg *Registry, name string) *Upstream {
	t.Helper()
	up, ok := reg.Get(name)
	if !ok {
		t.Fatalf("context %q missing from the registry", name)
	}
	return up
}

// The mode is stamped from what RESTConfigs actually prepared, never re-read
// from the flag: the carve-out applies to the kubeconfig branch only, so an
// --api-server upstream (anonymized) marked as credentialed would authenticate
// with nothing at all — RequireToken would wave the request through, the
// gateway would delete the client's Authorization, and every call would 401
// with nothing naming the cause. config.validate rejects this combination, so
// this pins the behaviour for any caller that reaches NewRegistry directly.
func TestNewRegistryDerivesCredentialModeFromPreparedConfig(t *testing.T) {
	reg, err := NewRegistry(&config.Config{
		KubeAPIServer:            "https://explicit.example:6443",
		UseKubeconfigCredentials: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if reg.UsesConfigCredentials() {
		t.Error("an anonymized --api-server upstream must not be marked as credentialed")
	}
	if reg.Default().UseConfigCredentials {
		t.Error("upstream marked as credentialed despite carrying no credentials")
	}
	// And the token gate must still demand one, since nothing else can supply it.
	rec := httptest.NewRecorder()
	if _, ok := reg.RequireToken(rec, httptest.NewRequest(http.MethodGet, "/k8s/api", nil)); ok {
		t.Error("RequireToken must still require a bearer for an anonymized upstream")
	}
}

// Regression: Resolve("") returned r.byName[r.def] unchecked, so a registry
// whose default name has no upstream (NewRegistryFromUpstreams only documents
// the precondition; it does not enforce it) handed every caller a nil
// *Upstream with a nil error. The first BaseURL dereference then panicked into
// a 500 instead of failing closed the way any other unresolvable context does.
func TestResolveFailsClosedWhenTheDefaultHasNoUpstream(t *testing.T) {
	base, _ := url.Parse("https://alpha.example")
	reg := NewRegistryFromUpstreams("missing", map[string]*Upstream{
		"alpha": {BaseURL: base, Transport: http.DefaultTransport},
	})

	up, name, err := reg.Resolve("")
	if !errors.Is(err, ErrUnknownContext) {
		t.Fatalf("Resolve(\"\") = %v/%q/%v, want ErrUnknownContext", up, name, err)
	}
	if up != nil {
		t.Error("Resolve returned an upstream alongside the error")
	}

	// The HTTP chokepoint turns it into the canonical 400, never a panic.
	rec := httptest.NewRecorder()
	if _, _, ok := reg.ResolveRequest(rec, httptest.NewRequest(http.MethodGet, "/k8s/api", nil)); ok {
		t.Fatal("ResolveRequest reported success for an unresolvable default")
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}
