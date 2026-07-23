package kube

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
)

// TestDoDoesNotFollowRedirects guards the invariant that kube.Do never follows
// a redirect: WithBearer re-attaches the token on every hop, so following a 3xx
// would leak the bearer token to the redirect target.
func TestDoDoesNotFollowRedirects(t *testing.T) {
	var leaked atomic.Bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "/leak", http.StatusFound)
		case "/leak":
			leaked.Store(true)
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer ts.Close()

	base, _ := url.Parse(ts.URL)
	up := &Upstream{BaseURL: base, Transport: http.DefaultTransport}

	resp, err := Do(context.Background(), up, "SENTINEL-token", http.MethodGet, "/redirect", nil, nil)
	if err != nil {
		t.Fatalf("Do returned error: %v", err)
	}
	_ = resp.Body.Close()

	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want 302 handed back unfollowed", resp.StatusCode)
	}
	if leaked.Load() {
		t.Fatal("redirect was followed: bearer token leaked to the redirect target")
	}
}
