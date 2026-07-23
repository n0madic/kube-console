package server

import (
	"context"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/n0madic/kube-console/internal/httpx"
	"github.com/n0madic/kube-console/internal/kube"
)

const (
	// readinessTTL is how long a probe result is reused. /readyz is
	// unauthenticated, so without it every hit — from a kubelet probe or from
	// anyone who can reach the port — turns into one more request to the
	// apiserver. A few seconds is well inside any sane probe period and still
	// reports a genuinely unreachable apiserver promptly.
	readinessTTL = 5 * time.Second
	// readinessProbeTimeout bounds the upstream probe itself.
	readinessProbeTimeout = 3 * time.Second
)

// readinessCache probes the default context's apiserver at most once per
// readinessTTL and shares the outcome with every concurrent caller.
type readinessCache struct {
	up  *kube.Upstream
	ttl time.Duration

	// mu also serializes the probe: a caller arriving while one is in flight
	// waits for it and then reads the fresh result, so a burst of probes still
	// makes a single upstream request.
	mu      sync.Mutex
	checked time.Time
	ready   bool
}

func newReadinessCache(up *kube.Upstream, ttl time.Duration) *readinessCache {
	return &readinessCache{up: up, ttl: ttl}
}

// ready reports whether the upstream answered recently, probing if the cached
// result has aged out.
func (c *readinessCache) isReady() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.checked.IsZero() && time.Since(c.checked) < c.ttl {
		return c.ready
	}
	c.ready = c.probe()
	c.checked = time.Now()
	return c.ready
}

// probe performs an anonymous GET /version. Any HTTP response — including
// 401/403 — proves the apiserver is reachable; only transport-level failures
// make the backend not ready. It deliberately runs on a background context,
// not the caller's: the result is shared, so one client giving up must not
// record a failure for everyone else.
func (c *readinessCache) probe() bool {
	ctx, cancel := context.WithTimeout(context.Background(), readinessProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.up.BaseURL.String()+"/version", nil)
	if err != nil {
		return false
	}
	resp, err := c.up.Transport.RoundTrip(req)
	if err != nil {
		return false
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	_ = resp.Body.Close()
	return true
}

func (c *readinessCache) handler(w http.ResponseWriter, r *http.Request) {
	if !c.isReady() {
		httpx.WriteError(w, http.StatusServiceUnavailable, "ServiceUnavailable", "kube-apiserver is unreachable")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
