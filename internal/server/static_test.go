package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/kube"
)

var testDist = fstest.MapFS{
	"index.html":           {Data: []byte("<!doctype html><title>kube-console</title>")},
	"assets/app.abc123.js": {Data: []byte("console.log('app')")},
	"favicon.svg":          {Data: []byte("<svg/>")},
}

func TestSPAServesIndexWithNoStore(t *testing.T) {
	h := NewSPAHandler(testDist)
	for _, p := range []string{"/", "/login", "/overview", "/r/apps/v1/deployments"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", p, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "kube-console") {
			t.Errorf("GET %s did not serve index.html", p)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
			t.Errorf("GET %s Cache-Control = %q, want no-store", p, cc)
		}
	}
}

func TestSPAServesHashedAssetsImmutable(t *testing.T) {
	h := NewSPAHandler(testDist)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/app.abc123.js", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("Cache-Control = %q, want immutable", cc)
	}
}

func TestSPANeverFallsBackForAPIPaths(t *testing.T) {
	h := NewSPAHandler(testDist)
	// The un-normalized spellings matter: chi does not clean paths, so these
	// reach the SPA fallback verbatim and must not be answered with index.html.
	for _, p := range []string{
		"/k8s/api/v1/pods", "/api/ui/discovery", "/k8s", "/api",
		"//api/ui/discovery", "//k8s/api/v1/pods", "/k8s/../k8s/api", "/api/ui/./contexts",
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", p, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "<title>") {
			t.Errorf("GET %s served HTML instead of a JSON error", p)
		}
	}
}

func newTestHandler(t *testing.T) http.Handler {
	t.Helper()
	base, _ := url.Parse("http://127.0.0.1:1")
	cfg := &config.Config{MaxBodyBytes: 4 << 20, MaxExecSessions: 1}
	up := &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport}
	return NewHandler(Deps{
		Cfg:      cfg,
		Registry: kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up}),
		Logger:   slog.New(slog.DiscardHandler),
		Version:  "test",
		DistFS:   testDist,
	})
}

func TestRouterBlockedExecIsJSON403EvenWithSPA(t *testing.T) {
	h := newTestHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/k8s/api/v1/namespaces/ns/pods/p/exec", nil)
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (SPA fallback must not mask the block)", rec.Code)
	}
	var status map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatalf("expected JSON Status body, got %q", rec.Body.String())
	}
}

func TestRouterUnknownAPIPathIsJSON404(t *testing.T) {
	h := newTestHandler(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "<title>") {
		t.Fatal("/api/* must never serve HTML")
	}
}

func TestRouterHealthz(t *testing.T) {
	h := newTestHandler(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("healthz = %d, want 200", rec.Code)
	}
}

func TestRouterSPAFallback(t *testing.T) {
	h := newTestHandler(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/r/core/v1/pods", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "kube-console") {
		t.Fatalf("SPA fallback failed: %d %q", rec.Code, rec.Body.String())
	}
}
