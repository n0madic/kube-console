package metrics

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/n0madic/kube-console/internal/kube"
)

func newMetricsRouter(t *testing.T, enabled bool, upstream http.HandlerFunc) http.Handler {
	t.Helper()
	var up *kube.Upstream
	if upstream != nil {
		ts := httptest.NewServer(upstream)
		t.Cleanup(ts.Close)
		base, _ := url.Parse(ts.URL)
		up = &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport}
	} else {
		base, _ := url.Parse("http://127.0.0.1:1") // connection refused
		up = &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport}
	}
	reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up})
	return newMetricsRouterForRegistry(NewHandler(reg, enabled))
}

func newMetricsRouterForRegistry(h *Handler) http.Handler {
	r := chi.NewRouter()
	r.Get("/api/ui/metrics/capabilities", h.Capabilities)
	r.Get("/api/ui/metrics/pods", h.Pods)
	r.Get("/api/ui/metrics/pods/{namespace}/{name}", h.Pod)
	r.Get("/api/ui/metrics/nodes", h.Nodes)
	r.Get("/api/ui/metrics/nodes/{name}", h.Node)
	return r
}

func getMetrics(h http.Handler, path string) *httptest.ResponseRecorder {
	return getMetricsContext(h, path, "")
}

func getMetricsContext(h http.Handler, path, context string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer tok")
	if context != "" {
		req.Header.Set("X-Kube-Context", context)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeCaps(t *testing.T, rec *httptest.ResponseRecorder) Capabilities {
	t.Helper()
	var caps Capabilities
	if err := json.Unmarshal(rec.Body.Bytes(), &caps); err != nil {
		t.Fatalf("bad capabilities body %q: %v", rec.Body.String(), err)
	}
	return caps
}

func TestCapabilitiesDisabled(t *testing.T) {
	h := newMetricsRouter(t, false, func(w http.ResponseWriter, r *http.Request) {
		t.Error("upstream must not be called when disabled")
	})
	caps := decodeCaps(t, getMetrics(h, "/api/ui/metrics/capabilities"))
	if caps.State != StateDisabled {
		t.Fatalf("state = %q, want disabled", caps.State)
	}
}

func TestCapabilitiesAvailable(t *testing.T) {
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apis/metrics.k8s.io" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"kind":"APIGroup","name":"metrics.k8s.io",
			"versions":[{"groupVersion":"metrics.k8s.io/v1beta1","version":"v1beta1"}],
			"preferredVersion":{"groupVersion":"metrics.k8s.io/v1beta1","version":"v1beta1"}}`))
	})
	caps := decodeCaps(t, getMetrics(h, "/api/ui/metrics/capabilities"))
	if caps.State != StateAvailable || caps.Group != "metrics.k8s.io" || caps.Version != "v1beta1" {
		t.Fatalf("caps = %+v", caps)
	}
}

// The version is spliced into the upstream path, so anything that is not a
// plain API version name is refused. The scan must not stop at versions[0]:
// one unusable entry ahead of a valid one used to fail the whole probe closed.
func TestCapabilitiesSkipsUnusableVersions(t *testing.T) {
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"kind":"APIGroup","name":"metrics.k8s.io",
			"versions":[
				{"groupVersion":"metrics.k8s.io/v1beta1?x=1","version":"v1beta1?x=1"},
				{"groupVersion":"metrics.k8s.io/v1beta1","version":"v1beta1"}],
			"preferredVersion":{"groupVersion":"metrics.k8s.io/../../","version":"../../"}}`))
	})
	if caps := decodeCaps(t, getMetrics(h, "/api/ui/metrics/capabilities")); caps.Version != "v1beta1" ||
		caps.State != StateAvailable {
		t.Fatalf("caps = %+v, want the first usable version", caps)
	}
}

func TestCapabilitiesUnavailableWhenNoVersionIsUsable(t *testing.T) {
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"kind":"APIGroup","name":"metrics.k8s.io",
			"versions":[{"groupVersion":"metrics.k8s.io/v1beta1/pods","version":"v1beta1/pods"}],
			"preferredVersion":{"groupVersion":"metrics.k8s.io/","version":""}}`))
	})
	if caps := decodeCaps(t, getMetrics(h, "/api/ui/metrics/capabilities")); caps.State != StateUnavailable {
		t.Fatalf("caps = %+v, want unavailable", caps)
	}
}

func TestCapabilitiesNotInstalled(t *testing.T) {
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	if caps := decodeCaps(t, getMetrics(h, "/api/ui/metrics/capabilities")); caps.State != StateNotInstalled {
		t.Fatalf("state = %q, want not-installed", caps.State)
	}
}

func TestCapabilitiesForbidden(t *testing.T) {
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})
	if caps := decodeCaps(t, getMetrics(h, "/api/ui/metrics/capabilities")); caps.State != StateForbidden {
		t.Fatalf("state = %q, want forbidden", caps.State)
	}
}

func TestCapabilitiesUnavailableOn5xx(t *testing.T) {
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	if caps := decodeCaps(t, getMetrics(h, "/api/ui/metrics/capabilities")); caps.State != StateUnavailable {
		t.Fatalf("state = %q, want unavailable", caps.State)
	}
}

func TestCapabilitiesUnavailableOnNetworkError(t *testing.T) {
	h := newMetricsRouter(t, true, nil)
	if caps := decodeCaps(t, getMetrics(h, "/api/ui/metrics/capabilities")); caps.State != StateUnavailable {
		t.Fatalf("state = %q, want unavailable", caps.State)
	}
}

func TestPodMetricsHappyPath(t *testing.T) {
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/apis/metrics.k8s.io":
			_, _ = w.Write([]byte(`{"kind":"APIGroup","name":"metrics.k8s.io",
				"preferredVersion":{"groupVersion":"metrics.k8s.io/v1beta1","version":"v1beta1"}}`))
		case "/apis/metrics.k8s.io/v1beta1/namespaces/default/pods/api-123":
			_, _ = w.Write([]byte(`{
				"metadata":{"name":"api-123","namespace":"default","uid":"u-1"},
				"timestamp":"2026-07-19T14:25:30Z","window":"30s",
				"containers":[{"name":"api","usage":{"cpu":"250m","memory":"129Mi"}}]}`))
		default:
			t.Errorf("unexpected upstream path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	rec := getMetrics(h, "/api/ui/metrics/pods/default/api-123")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out Response
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.ObservedAt != "2026-07-19T14:25:30Z" || out.WindowSeconds != 30 {
		t.Fatalf("observedAt/window mismatch: %+v", out)
	}
	if len(out.Items) != 1 || out.Items[0].CPUNanoCores != 250_000_000 || out.Items[0].MemoryBytes != 135_266_304 {
		t.Fatalf("items mismatch: %+v", out.Items)
	}
}

func TestPodMetricsForbiddenPassthrough(t *testing.T) {
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/apis/metrics.k8s.io":
			_, _ = w.Write([]byte(`{"kind":"APIGroup","name":"metrics.k8s.io",
				"preferredVersion":{"groupVersion":"metrics.k8s.io/v1beta1","version":"v1beta1"}}`))
		default:
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"kind":"Status","status":"Failure","reason":"Forbidden","code":403}`))
		}
	})
	rec := getMetrics(h, "/api/ui/metrics/pods?namespace=default")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 passthrough", rec.Code)
	}
	var status map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil || status["reason"] != "Forbidden" {
		t.Fatalf("expected Status passthrough, got %q", rec.Body.String())
	}
}

func TestPodMetricsEmptyListSerializesAsArray(t *testing.T) {
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/apis/metrics.k8s.io":
			_, _ = w.Write([]byte(`{"kind":"APIGroup","name":"metrics.k8s.io",
				"preferredVersion":{"groupVersion":"metrics.k8s.io/v1beta1","version":"v1beta1"}}`))
		case "/apis/metrics.k8s.io/v1beta1/pods":
			_, _ = w.Write([]byte(`{"items":[]}`))
		default:
			t.Errorf("unexpected upstream path %s", r.URL.Path)
		}
	})
	rec := getMetrics(h, "/api/ui/metrics/pods")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"items":[]`) {
		t.Fatalf("empty list must serialize items as [], got %q", rec.Body.String())
	}
}

func TestVersionCachedAcrossDataRequests(t *testing.T) {
	var probes atomic.Int32
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/apis/metrics.k8s.io":
			probes.Add(1)
			_, _ = w.Write([]byte(`{"kind":"APIGroup","name":"metrics.k8s.io",
				"preferredVersion":{"groupVersion":"metrics.k8s.io/v1beta1","version":"v1beta1"}}`))
		case "/apis/metrics.k8s.io/v1beta1/nodes":
			_, _ = w.Write([]byte(`{"items":[]}`))
		default:
			t.Errorf("unexpected upstream path %s", r.URL.Path)
		}
	})
	for i := 0; i < 3; i++ {
		if rec := getMetrics(h, "/api/ui/metrics/nodes"); rec.Code != http.StatusOK {
			t.Fatalf("request %d: status %d", i, rec.Code)
		}
	}
	if got := probes.Load(); got != 1 {
		t.Fatalf("capability probe hit %d times across 3 data requests, want 1 (version must be cached)", got)
	}
}

// The version cache is keyed per context: two clusters running different
// metrics.k8s.io versions must not bleed into one another.
func TestVersionCacheIsolatedPerContext(t *testing.T) {
	makeUpstream := func(version string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Path {
			case "/apis/metrics.k8s.io":
				_, _ = w.Write([]byte(`{"kind":"APIGroup","name":"metrics.k8s.io",
					"preferredVersion":{"groupVersion":"metrics.k8s.io/` + version + `","version":"` + version + `"}}`))
			case "/apis/metrics.k8s.io/" + version + "/nodes":
				_, _ = w.Write([]byte(`{"items":[]}`))
			default:
				t.Errorf("context served unexpected path %s (version mixing?)", r.URL.Path)
				w.WriteHeader(http.StatusNotFound)
			}
		}))
	}
	alpha := makeUpstream("v1beta1")
	t.Cleanup(alpha.Close)
	beta := makeUpstream("v1")
	t.Cleanup(beta.Close)
	alphaBase, _ := url.Parse(alpha.URL)
	betaBase, _ := url.Parse(beta.URL)
	reg := kube.NewRegistryFromUpstreams("alpha", map[string]*kube.Upstream{
		"alpha": {BaseURL: alphaBase, Transport: http.DefaultTransport},
		"beta":  {BaseURL: betaBase, Transport: http.DefaultTransport},
	})
	h := newMetricsRouterForRegistry(NewHandler(reg, true))

	// Prime alpha's cache (v1beta1), then hit beta (v1). If the cache mixed,
	// beta would request /v1beta1/nodes and the upstream would flag it.
	for _, ctx := range []string{"alpha", "beta", "alpha", "beta"} {
		if rec := getMetricsContext(h, "/api/ui/metrics/nodes", ctx); rec.Code != http.StatusOK {
			t.Fatalf("context %s: status %d: %s", ctx, rec.Code, rec.Body.String())
		}
	}
}

func TestMetricsUnknownContext400(t *testing.T) {
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		t.Error("upstream must not be called for an unknown context")
	})
	if rec := getMetricsContext(h, "/api/ui/metrics/nodes", "ghost"); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for unknown context", rec.Code)
	}
}

func TestPodMetricsInvalidNames(t *testing.T) {
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		t.Error("upstream must not be called for invalid names")
	})
	for _, p := range []string{
		"/api/ui/metrics/pods?namespace=UPPER",
		"/api/ui/metrics/pods?namespace=bad%20ns",
	} {
		if rec := getMetrics(h, p); rec.Code != http.StatusBadRequest {
			t.Errorf("GET %s = %d, want 400", p, rec.Code)
		}
	}
}

// Regression: metrics upstream calls ran on the bare request context, so an
// upstream that accepted the connection and never responded pinned the
// handler goroutine for as long as the client kept its socket open.
func TestMetricsUpstreamStallBoundedByTimeout(t *testing.T) {
	prev := upstreamTimeout
	upstreamTimeout = 100 * time.Millisecond
	t.Cleanup(func() { upstreamTimeout = prev })

	// Unblocked in cleanup (LIFO: runs before the server's Close) so the
	// stalled upstream handler never wedges httptest.Server.Close.
	stop := make(chan struct{})
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		select { // stall until the client abandons the request
		case <-r.Context().Done():
		case <-stop:
		}
	})
	t.Cleanup(func() { close(stop) })

	start := time.Now()
	rec := getMetrics(h, "/api/ui/metrics/nodes")
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("handler blocked for %v; timeout not applied", elapsed)
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body %s", rec.Code, rec.Body.String())
	}
}
