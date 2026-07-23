package kube

import (
	"errors"
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
