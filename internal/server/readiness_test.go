package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/n0madic/kube-console/internal/kube"
)

// newCountingUpstream returns an upstream whose /version hits are counted.
func newCountingUpstream(t *testing.T) (*kube.Upstream, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ts.Close)
	base, _ := url.Parse(ts.URL)
	return &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport}, &hits
}

// /readyz is unauthenticated, so a flood of probes must not be replayed into
// the apiserver one-for-one.
func TestReadinessProbeIsCached(t *testing.T) {
	up, hits := newCountingUpstream(t)
	c := newReadinessCache(up, time.Minute)

	for i := 0; i < 20; i++ {
		rec := httptest.NewRecorder()
		c.handler(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("probe %d: status = %d, want 200", i, rec.Code)
		}
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("upstream probes = %d, want 1 within the TTL", got)
	}
}

func TestReadinessProbeRefreshesAfterTTL(t *testing.T) {
	up, hits := newCountingUpstream(t)
	c := newReadinessCache(up, 20*time.Millisecond)

	c.handler(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/readyz", nil))
	time.Sleep(40 * time.Millisecond)
	c.handler(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if got := hits.Load(); got != 2 {
		t.Fatalf("upstream probes = %d, want 2 across the TTL boundary", got)
	}
}

// Concurrent probes collapse onto one upstream request instead of each firing
// its own before the first result is stored.
func TestReadinessProbeCollapsesConcurrentCallers(t *testing.T) {
	up, hits := newCountingUpstream(t)
	c := newReadinessCache(up, time.Minute)

	var wg sync.WaitGroup
	for i := 0; i < 25; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.handler(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/readyz", nil))
		}()
	}
	wg.Wait()
	if got := hits.Load(); got != 1 {
		t.Fatalf("upstream probes = %d, want 1 for a concurrent burst", got)
	}
}

// A caller that gives up must not record a failure for everyone else: the
// probe runs on its own context, and an unreachable upstream still reports 503.
func TestReadinessReportsUnreachableUpstream(t *testing.T) {
	base, _ := url.Parse("http://127.0.0.1:1")
	c := newReadinessCache(&kube.Upstream{BaseURL: base, Transport: http.DefaultTransport}, time.Minute)
	rec := httptest.NewRecorder()
	c.handler(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 for an unreachable apiserver", rec.Code)
	}
}
