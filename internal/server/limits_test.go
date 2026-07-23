package server

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"

	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/kube"
)

// newLimitedHandler wires the full router against an unreachable upstream:
// every limiter test asserts on requests that are shed (429) or rejected
// before dispatch (401), so the upstream is never contacted.
func newLimitedHandler(t *testing.T, tune func(*config.Config)) http.Handler {
	t.Helper()
	base, _ := url.Parse("http://127.0.0.1:1")
	cfg := &config.Config{MaxBodyBytes: 4 << 20, MaxExecSessions: 1}
	tune(cfg)
	reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{
		"default": {BaseURL: base, Transport: http.DefaultTransport},
	})
	return NewHandler(Deps{
		Cfg:      cfg,
		Registry: reg,
		Logger:   slog.New(slog.DiscardHandler),
		Version:  "test",
		DistFS:   testDist,
	})
}

// get issues a request from a given client address, optionally with an
// X-Forwarded-For chain.
func get(h http.Handler, path, remoteAddr, xff string) int {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.RemoteAddr = remoteAddr
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

// An unauthenticated flood is shed by the limiter, which sits ahead of the
// gateway's own checks: the first requests are rejected as 401 (no bearer),
// and past the budget they cost nothing but the limiter check.
func TestRateLimitShedsUnauthenticatedFlood(t *testing.T) {
	h := newLimitedHandler(t, func(c *config.Config) { c.RateLimit = 3 })
	for i := 0; i < 3; i++ {
		if code := get(h, "/k8s/api/v1/pods", "203.0.113.7:5000", ""); code != http.StatusUnauthorized {
			t.Fatalf("request %d: status = %d, want 401 within the budget", i, code)
		}
	}
	if code := get(h, "/k8s/api/v1/pods", "203.0.113.7:5000", ""); code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 past the budget", code)
	}
}

func TestRateLimitIsPerClientIP(t *testing.T) {
	h := newLimitedHandler(t, func(c *config.Config) { c.RateLimit = 2 })
	for i := 0; i < 3; i++ {
		get(h, "/k8s/api/v1/pods", "203.0.113.7:5000", "")
	}
	if code := get(h, "/k8s/api/v1/pods", "203.0.113.8:5000", ""); code != http.StatusUnauthorized {
		t.Fatalf("status = %d: another client must not inherit an exhausted budget", code)
	}
}

// One budget covers both proxied prefixes; alternating between them must not
// let a client spend it twice.
func TestRateLimitSharedAcrossGatewayAndAPI(t *testing.T) {
	h := newLimitedHandler(t, func(c *config.Config) { c.RateLimit = 2 })
	if code := get(h, "/k8s/api/v1/pods", "203.0.113.9:5000", ""); code != http.StatusUnauthorized {
		t.Fatalf("gateway request status = %d, want 401", code)
	}
	if code := get(h, "/api/ui/contexts", "203.0.113.9:5000", ""); code != http.StatusUnauthorized {
		t.Fatalf("api request status = %d, want 401", code)
	}
	if code := get(h, "/api/ui/contexts", "203.0.113.9:5000", ""); code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429: the two prefixes must share one budget", code)
	}
}

// Probes and the SPA are never rate limited: a kubelet that gets 429 on
// /readyz would restart the pod.
func TestRateLimitSkipsProbesAndStatic(t *testing.T) {
	h := newLimitedHandler(t, func(c *config.Config) { c.RateLimit = 1 })
	for i := 0; i < 5; i++ {
		if code := get(h, "/healthz", "203.0.113.10:5000", ""); code != http.StatusOK {
			t.Fatalf("/healthz status = %d on request %d", code, i)
		}
		if code := get(h, "/", "203.0.113.10:5000", ""); code != http.StatusOK {
			t.Fatalf("SPA status = %d on request %d", code, i)
		}
	}
}

func TestRateLimitDisabled(t *testing.T) {
	h := newLimitedHandler(t, func(c *config.Config) { c.RateLimit = 0 })
	for i := 0; i < 20; i++ {
		if code := get(h, "/k8s/api/v1/pods", "203.0.113.11:5000", ""); code != http.StatusUnauthorized {
			t.Fatalf("request %d: status = %d, want 401 with rate limiting off", i, code)
		}
	}
}

// X-Forwarded-For is client-supplied: without configured trusted proxies it
// must not influence the limiter key, or varying it would buy a fresh budget
// per request.
func TestRateLimitIgnoresUntrustedForwardedFor(t *testing.T) {
	h := newLimitedHandler(t, func(c *config.Config) { c.RateLimit = 2 })
	get(h, "/k8s/api/v1/pods", "203.0.113.12:5000", "198.51.100.1")
	get(h, "/k8s/api/v1/pods", "203.0.113.12:5000", "198.51.100.2")
	if code := get(h, "/k8s/api/v1/pods", "203.0.113.12:5000", "198.51.100.3"); code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429: a forged X-Forwarded-For must not reset the budget", code)
	}
}

// With the proxy's CIDR configured, the forwarded client IP becomes the key so
// users behind one ingress get their own budgets.
func TestRateLimitHonorsTrustedForwardedFor(t *testing.T) {
	h := newLimitedHandler(t, func(c *config.Config) {
		c.RateLimit = 2
		c.TrustedProxies = []string{"203.0.113.0/24"}
	})
	for i := 0; i < 3; i++ {
		get(h, "/k8s/api/v1/pods", "203.0.113.13:5000", "198.51.100.1")
	}
	if code := get(h, "/k8s/api/v1/pods", "203.0.113.13:5000", "198.51.100.2"); code != http.StatusUnauthorized {
		t.Fatalf("status = %d: a second user behind the proxy must have its own budget", code)
	}
}

func TestInFlightLimitShedsWhenSaturated(t *testing.T) {
	l := newInFlightLimiter(1)
	release := make(chan struct{})
	entered := make(chan struct{})
	var once sync.Once // only the first request signals; the last one re-enters
	h := l.middleware(nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		once.Do(func() { close(entered) })
		<-release
		w.WriteHeader(http.StatusOK)
	}))

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods", nil))
	}()
	<-entered

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 while the only slot is taken", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("a shed request must carry Retry-After")
	}

	close(release)
	wg.Wait()

	// The slot is returned when the request completes.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 once the slot is free", rec.Code)
	}
}

// Watches and log follows run for as long as the user keeps the page open;
// counting them would fill the cap with idle streams.
func TestInFlightLimitSkipsLongLivedRequests(t *testing.T) {
	l := newInFlightLimiter(1)
	release := make(chan struct{})
	entered := make(chan struct{})
	longLived := func(r *http.Request) bool { return r.URL.Query().Get("watch") == "true" }
	h := l.middleware(longLived)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("watch") == "true" {
			close(entered)
			<-release
		}
		w.WriteHeader(http.StatusOK)
	}))

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods?watch=true", nil))
	}()
	<-entered

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: an open watch must not consume an in-flight slot", rec.Code)
	}
	close(release)
	wg.Wait()
}

// Regression: long-lived requests were exempted from the cap outright, and
// "long-lived" is decided by a client-supplied query parameter — so appending
// `?watch=true` opted a request out of the only global concurrency bound. They
// now go into a separate, much larger pool that is still bounded.
func TestInFlightLimitBoundsLongLivedRequestsToo(t *testing.T) {
	l := newInFlightLimiter(1) // 1 unary slot, streamPoolFactor stream slots
	release := make(chan struct{})
	var entered sync.WaitGroup
	longLived := func(r *http.Request) bool { return r.URL.Query().Get("watch") == "true" }
	h := l.middleware(longLived)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered.Done()
		<-release
		w.WriteHeader(http.StatusOK)
	}))

	var wg sync.WaitGroup
	entered.Add(streamPoolFactor)
	for i := 0; i < streamPoolFactor; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods?watch=true", nil))
		}()
	}
	entered.Wait()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods?watch=true", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429: the stream pool must be bounded", rec.Code)
	}
	close(release)
	wg.Wait()
}

func TestInFlightLimitDisabledIsPassthrough(t *testing.T) {
	var l *inFlightLimiter // newInFlightLimiter(0) returns nil
	if got := newInFlightLimiter(0); got != nil {
		t.Fatalf("newInFlightLimiter(0) = %v, want nil", got)
	}
	h := l.middleware(nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 with the cap disabled", rec.Code)
	}
}

