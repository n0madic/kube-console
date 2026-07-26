package metrics

import (
	"encoding/json"
	"io"
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

// Regression: a cached metrics API version had no invalidation, so a version
// the server stopped serving (metrics-server upgraded mid-TTL) had its 404
// forwarded verbatim for the rest of the TTL — every chart read a live
// metrics-server as absent. A 404/503 data response drops the entry and the
// next request re-probes.
func TestStaleCachedVersionReprobedAfter404(t *testing.T) {
	var served atomic.Value
	served.Store("v1beta1")
	var probes atomic.Int32
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		version := served.Load().(string)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/apis/metrics.k8s.io":
			probes.Add(1)
			_, _ = w.Write([]byte(`{"kind":"APIGroup","name":"metrics.k8s.io",
				"preferredVersion":{"groupVersion":"metrics.k8s.io/` + version + `","version":"` + version + `"}}`))
		case "/apis/metrics.k8s.io/" + version + "/nodes":
			_, _ = w.Write([]byte(`{"items":[]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","status":"Failure","reason":"NotFound","code":404}`))
		}
	})

	// Prime the cache with v1beta1.
	if rec := getMetrics(h, "/api/ui/metrics/nodes"); rec.Code != http.StatusOK {
		t.Fatalf("prime: status = %d: %s", rec.Code, rec.Body.String())
	}
	// The upstream now serves v1 only; the cached v1beta1 path 404s, forwarded
	// with the upstream body as before...
	served.Store("v1")
	if rec := getMetrics(h, "/api/ui/metrics/nodes"); rec.Code != http.StatusNotFound {
		t.Fatalf("stale version: status = %d, want the upstream 404: %s", rec.Code, rec.Body.String())
	}
	// ...but is not replayed: the next request re-probes and succeeds.
	if rec := getMetrics(h, "/api/ui/metrics/nodes"); rec.Code != http.StatusOK {
		t.Fatalf("after re-probe: status = %d: %s", rec.Code, rec.Body.String())
	}
	if got := probes.Load(); got != 2 {
		t.Fatalf("capability probe hit %d times, want 2 (prime + re-probe after the stale 404)", got)
	}
}

// Regression: the 404 invalidation above fired for single-object requests too,
// where 404 is the *ordinary* answer — metrics-server returns it for any pod it
// has not scraped yet. So opening the Metrics tab on a fresh pod evicted a
// cluster-global, per-context cache on every 15s poll for that pod's first
// minute, and every other user of the context paid a capability probe per
// request. Only a collection 404 says the version is gone.
func TestSingleObject404KeepsCachedVersion(t *testing.T) {
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
			// Every pod lookup: not scraped yet.
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","status":"Failure","reason":"NotFound","code":404}`))
		}
	})

	if rec := getMetrics(h, "/api/ui/metrics/nodes"); rec.Code != http.StatusOK {
		t.Fatalf("prime: status = %d: %s", rec.Code, rec.Body.String())
	}
	for range 3 {
		rec := getMetrics(h, "/api/ui/metrics/pods/default/fresh-pod")
		if rec.Code != http.StatusNotFound {
			t.Fatalf("pod metrics: status = %d, want the upstream 404: %s", rec.Code, rec.Body.String())
		}
	}
	if got := probes.Load(); got != 1 {
		t.Fatalf("capability probe hit %d times, want 1 (a per-object 404 must not drop the cache)", got)
	}
}

// The complement of the probe caching above: a probe that no longer reports the
// group available must retire a version cached earlier, or a data request that
// never probes (the Overview's node metrics) keeps taking the cache-hit path
// into a group version this cluster stopped serving for the rest of the TTL.
func TestCapabilitiesProbeDropsCachedVersionWhenUnavailable(t *testing.T) {
	var installed atomic.Bool
	installed.Store(true)
	var probes atomic.Int32
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/apis/metrics.k8s.io":
			probes.Add(1)
			if !installed.Load() {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"kind":"Status","code":404}`))
				return
			}
			_, _ = w.Write([]byte(`{"kind":"APIGroup","name":"metrics.k8s.io",
				"preferredVersion":{"groupVersion":"metrics.k8s.io/v1beta1","version":"v1beta1"}}`))
		case "/apis/metrics.k8s.io/v1beta1/nodes":
			_, _ = w.Write([]byte(`{"items":[]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","code":404}`))
		}
	})

	if rec := getMetrics(h, "/api/ui/metrics/capabilities"); decodeCaps(t, rec).State != StateAvailable {
		t.Fatalf("prime: state = %q, want available", decodeCaps(t, rec).State)
	}
	installed.Store(false)
	if rec := getMetrics(h, "/api/ui/metrics/capabilities"); decodeCaps(t, rec).State != StateNotInstalled {
		t.Fatalf("after uninstall: state = %q, want not-installed", decodeCaps(t, rec).State)
	}
	before := probes.Load()
	// The data request must re-probe (and answer not-installed) rather than
	// replay the retired version.
	if rec := getMetrics(h, "/api/ui/metrics/nodes"); rec.Code != http.StatusNotFound {
		t.Fatalf("data request: status = %d, want 404: %s", rec.Code, rec.Body.String())
	}
	if got := probes.Load(); got != before+1 {
		t.Fatalf("capability probes = %d, want %d (the data request must re-probe)", got, before+1)
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

// Every namespace/name here is spliced into the upstream metrics path, so all
// three routes gate on kube.IsDNS1123Subdomain (see internal/kube/names.go).
// The verdict itself is pinned by that package's agreement test; what this
// covers is that each route actually asks — including the two that only got a
// shared validator when the duplicated pattern was removed.
func TestPodMetricsInvalidNames(t *testing.T) {
	h := newMetricsRouter(t, true, func(w http.ResponseWriter, r *http.Request) {
		t.Error("upstream must not be called for invalid names")
	})
	for _, p := range []string{
		"/api/ui/metrics/pods?namespace=UPPER",
		"/api/ui/metrics/pods?namespace=bad%20ns",
		"/api/ui/metrics/pods?namespace=" + strings.Repeat("n", 254),
		"/api/ui/metrics/pods/UPPER/api-123",
		"/api/ui/metrics/pods/default/BadPod",
		"/api/ui/metrics/pods/default/" + strings.Repeat("p", 254),
		"/api/ui/metrics/nodes/NODE",
		"/api/ui/metrics/nodes/bad_node",
		"/api/ui/metrics/nodes/" + strings.Repeat("n", 254),
	} {
		if rec := getMetrics(h, p); rec.Code != http.StatusBadRequest {
			t.Errorf("GET %s = %d, want 400", p, rec.Code)
		}
	}
}

// stubTransport answers upstream requests from a function, so a test can hand
// the handler a response body it fully controls. A real httptest upstream
// cannot serve this purpose: the kernel and net/http buffer whatever the server
// writes, so how much of a body the handler consumed is not observable there,
// and the only remaining instrument — wall clock — measures the load on the
// machine as much as the code (a correct, bounded drain reported 3s under a
// parallel -race run).
type stubTransport func(*http.Request) *http.Response

func (s stubTransport) RoundTrip(r *http.Request) (*http.Response, error) { return s(r), nil }

// countingBody offers far more data than any drain should want and records how
// much of it was read, and whether it was closed. It ends at EOF rather than
// going on forever so that an unbounded drain fails the test loudly instead of
// hanging it.
type countingBody struct {
	prefix    string
	remaining int
	read      int
	closed    bool
}

func (b *countingBody) Read(p []byte) (int, error) {
	if b.prefix != "" {
		n := copy(p, b.prefix)
		b.prefix = b.prefix[n:]
		b.read += n
		return n, nil
	}
	if b.remaining == 0 {
		return 0, io.EOF
	}
	n := min(len(p), b.remaining)
	for i := range p[:n] {
		p[i] = 'x'
	}
	b.remaining -= n
	b.read += n
	return n, nil
}

func (b *countingBody) Close() error { b.closed = true; return nil }

func newMetricsRouterWithTransport(rt http.RoundTripper) http.Handler {
	base, _ := url.Parse("https://apiserver.invalid")
	up := &kube.Upstream{BaseURL: base, Transport: rt}
	reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up})
	return newMetricsRouterForRegistry(NewHandler(reg, true))
}

// maxDrained bounds what a metrics path may read out of a body it does not
// decode. httpx.DrainAndClose stops at 64 KiB; the slack covers the bytes a
// json.Decoder buffers before it gives up on the first token, and keeps this
// test from pinning httpx's exact constant.
const maxDrained = 128 << 10

// Both metrics paths that stop reading an upstream body early — the capability
// probe, which only wants the status, and a data response that failed to decode
// — used to drain it with an unbounded io.Copy, which made the time spent
// reading a body nobody wants the upstream's choice, paid while holding an
// in-flight slot. They now go through httpx.DrainAndClose.
func TestCapabilityProbeDrainIsBounded(t *testing.T) {
	body := &countingBody{remaining: 8 << 20}
	h := newMetricsRouterWithTransport(stubTransport(func(*http.Request) *http.Response {
		return &http.Response{StatusCode: http.StatusInternalServerError, Header: http.Header{}, Body: body}
	}))

	if caps := decodeCaps(t, getMetrics(h, "/api/ui/metrics/capabilities")); caps.State != StateUnavailable {
		t.Fatalf("state = %q, want unavailable", caps.State)
	}
	if !body.closed {
		t.Error("upstream body was not closed")
	}
	if body.read > maxDrained {
		t.Errorf("probe read %d bytes of a body whose status was all it wanted, want at most %d", body.read, maxDrained)
	}
}

func TestDataResponseDrainIsBounded(t *testing.T) {
	// "not-json" fails the decode on the first token, so the rest of the body is
	// never decoded — only drained.
	body := &countingBody{prefix: "not-json", remaining: 8 << 20}
	h := newMetricsRouterWithTransport(stubTransport(func(r *http.Request) *http.Response {
		if r.URL.Path == metricsGroupPath {
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(
				`{"kind":"APIGroup","name":"metrics.k8s.io",
				"preferredVersion":{"groupVersion":"metrics.k8s.io/v1beta1","version":"v1beta1"}}`))}
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: body}
	}))

	rec := getMetrics(h, "/api/ui/metrics/nodes")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 for an undecodable body: %s", rec.Code, rec.Body.String())
	}
	if !body.closed {
		t.Error("upstream body was not closed")
	}
	if body.read > maxDrained {
		t.Errorf("handler read %d bytes of a body it had already failed to decode, want at most %d", body.read, maxDrained)
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
