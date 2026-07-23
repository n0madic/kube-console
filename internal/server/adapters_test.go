package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/kube"
)

// acceptToken answers a SelfSubjectReview the way an apiserver does for a
// valid token.
func acceptToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write([]byte(`{"apiVersion":"authentication.k8s.io/v1","kind":"SelfSubjectReview",
		"status":{"userInfo":{"username":"jane"}}}`))
}

// newMultiContextHandler wires a two-context registry (alpha default + beta)
// behind the full router so /api/ui/contexts can be asserted end to end. Both
// contexts point at one fake apiserver, which decides whether the token passes
// verification.
func newMultiContextHandler(t *testing.T, upstream http.HandlerFunc) http.Handler {
	t.Helper()
	return newMultiContextHandlerNamed(t, upstream, "")
}

// newMultiContextHandlerNamed is newMultiContextHandler with an operator-set
// cluster display name (--cluster-name).
func newMultiContextHandlerNamed(t *testing.T, upstream http.HandlerFunc, clusterName string) http.Handler {
	t.Helper()
	ts := httptest.NewServer(upstream)
	t.Cleanup(ts.Close)
	base, _ := url.Parse(ts.URL)
	cfg := &config.Config{MaxBodyBytes: 4 << 20, MaxExecSessions: 1, ClusterName: clusterName}
	reg := kube.NewRegistryFromUpstreams("alpha", map[string]*kube.Upstream{
		"alpha": {BaseURL: base, Transport: http.DefaultTransport},
		"beta":  {BaseURL: base, Transport: http.DefaultTransport},
	})
	return NewHandler(Deps{
		Cfg:      cfg,
		Registry: reg,
		Logger:   slog.New(slog.DiscardHandler),
		Version:  "test",
		DistFS:   testDist,
	})
}

func getContexts(h http.Handler, bearer string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/ui/contexts", nil)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestContextsRequiresBearer(t *testing.T) {
	called := false
	h := newMultiContextHandler(t, func(w http.ResponseWriter, r *http.Request) {
		called = true
	})
	rec := getContexts(h, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 without a bearer", rec.Code)
	}
	if called {
		t.Fatal("a request without a bearer must not reach the apiserver")
	}
}

// The context names describe the estate, so a token that the apiserver
// rejects must not get them: before verification, sending the literal string
// "Bearer junk" was enough to list every cluster.
func TestContextsRejectsUnverifiedToken(t *testing.T) {
	h := newMultiContextHandler(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apis/authentication.k8s.io/v1/selfsubjectreviews" {
			t.Errorf("unexpected upstream path %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusUnauthorized)
	})
	rec := getContexts(h, "junk")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 for a token the apiserver rejects", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "alpha") || strings.Contains(rec.Body.String(), "beta") {
		t.Fatalf("context names leaked to an unauthenticated caller: %s", rec.Body.String())
	}
}

// A token that works but may not introspect itself (403 on SelfSubjectReview)
// is still a valid token: the UI must not lose its cluster switcher over a
// missing convenience permission.
func TestContextsAllowsIdentityUnavailableToken(t *testing.T) {
	h := newMultiContextHandler(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})
	rec := getContexts(h, "restricted")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: a 403 on SelfSubjectReview must not block the list", rec.Code)
	}
}

func TestContextsUnreachableUpstream502(t *testing.T) {
	h := newMultiContextHandler(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	rec := getContexts(h, "tok")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 when verification cannot be completed", rec.Code)
	}
}

func TestContextsReturnsNamesAndDefault(t *testing.T) {
	rec := getContexts(newMultiContextHandler(t, acceptToken), "tok")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Contexts []struct {
			Name string `json:"name"`
		} `json:"contexts"`
		Default string `json:"default"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Default != "alpha" {
		t.Errorf("default = %q, want alpha", out.Default)
	}
	if len(out.Contexts) != 2 || out.Contexts[0].Name != "alpha" || out.Contexts[1].Name != "beta" {
		t.Errorf("contexts = %+v, want sorted alpha+beta", out.Contexts)
	}
	// Server URLs and CAs must never be exposed: names + default only.
	var raw map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 2 {
		t.Errorf("response carries extra fields: %v", raw)
	}
	// Unset --cluster-name must not put an empty label in the response: the SPA
	// would then have to tell "" from absent to fall back to the context name.
	if _, ok := raw["clusterName"]; ok {
		t.Errorf("clusterName present without --cluster-name: %v", raw)
	}
}

func TestContextsReturnsClusterName(t *testing.T) {
	rec := getContexts(newMultiContextHandlerNamed(t, acceptToken, "prod-eu"), "tok")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		ClusterName string `json:"clusterName"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.ClusterName != "prod-eu" {
		t.Errorf("clusterName = %q, want prod-eu", out.ClusterName)
	}
}

// The label describes the estate exactly like the context names it ships with,
// so it must stay behind the same token check — an unverified caller gets
// neither.
func TestContextsClusterNameNeedsVerifiedToken(t *testing.T) {
	reject := func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}
	for name, bearer := range map[string]string{"no token": "", "bad token": "tok"} {
		t.Run(name, func(t *testing.T) {
			rec := getContexts(newMultiContextHandlerNamed(t, reject, "prod-eu"), bearer)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
			if strings.Contains(rec.Body.String(), "prod-eu") {
				t.Errorf("cluster name leaked to an unverified caller: %s", rec.Body.String())
			}
		})
	}
}
