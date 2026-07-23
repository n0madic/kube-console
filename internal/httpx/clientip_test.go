package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientIPFallsBackToRemoteAddr(t *testing.T) {
	// No resolver middleware ran, so nothing is stored in the context.
	req := httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods", nil)
	req.RemoteAddr = "198.51.100.24:9000"
	if got := ClientIP(req); got != "198.51.100.24" {
		t.Fatalf("ClientIP = %q, want the RemoteAddr host", got)
	}
}

// IPv6 clients are bucketed by /64: a single client usually controls the whole
// prefix and could otherwise rotate addresses for a fresh budget per request.
func TestClientIPBucketsIPv6By64(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods", nil)
	req.RemoteAddr = "[2001:db8:1:2:3:4:5:6]:9000"
	first := ClientIP(req)
	req.RemoteAddr = "[2001:db8:1:2:ffff:ffff:ffff:ffff]:9000"
	if second := ClientIP(req); second != first {
		t.Fatalf("ClientIP = %q and %q; addresses in one /64 must share a bucket", first, second)
	}
}

// The resolver stores what ClientIP reads back; without trusted proxies that
// is always the connection address, never a client-supplied header.
func TestClientIPResolverIgnoresForwardedForByDefault(t *testing.T) {
	var got string
	h := ClientIPResolver(nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = ClientIP(r)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.5:1111"
	req.Header.Set("X-Forwarded-For", "198.51.100.9")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if got != "203.0.113.5" {
		t.Fatalf("ClientIP = %q, want the connection address", got)
	}
}

func TestClientIPResolverHonorsTrustedProxy(t *testing.T) {
	var got string
	h := ClientIPResolver([]string{"203.0.113.0/24"})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = ClientIP(r)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.5:1111"
	req.Header.Set("X-Forwarded-For", "198.51.100.9, 203.0.113.5")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if got != "198.51.100.9" {
		t.Fatalf("ClientIP = %q, want the forwarded client address", got)
	}
}

// Regression: X-Forwarded-For was honored on the strength of the header alone.
// A connection that did not come through the proxy — anything reaching the pod
// or Service directly — could then pick its own limiter key and vary it per
// request, buying an unlimited rate-limit budget.
func TestClientIPResolverIgnoresForwardedForFromUntrustedPeer(t *testing.T) {
	var got string
	h := ClientIPResolver([]string{"203.0.113.0/24"})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = ClientIP(r)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.42.0.9:1111" // not the ingress
	req.Header.Set("X-Forwarded-For", "198.51.100.9")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if got != "10.42.0.9" {
		t.Fatalf("ClientIP = %q, want the connection address for an off-proxy peer", got)
	}
}

// A dual-stack listener surfaces an IPv4 peer as ::ffff:a.b.c.d; it must match
// the same v4 prefix, or the trust check would depend on socket configuration.
func TestClientIPResolverMatchesV4MappedPeer(t *testing.T) {
	var got string
	h := ClientIPResolver([]string{"203.0.113.0/24"})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = ClientIP(r)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "[::ffff:203.0.113.5]:1111"
	req.Header.Set("X-Forwarded-For", "198.51.100.9")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if got != "198.51.100.9" {
		t.Fatalf("ClientIP = %q, want the forwarded address for a v4-mapped proxy peer", got)
	}
}
