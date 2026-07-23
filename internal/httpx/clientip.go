package httpx

import (
	"net"
	"net/http"
	"net/netip"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httprate"
)

// ClientIPResolver stores the client IP in the request context, where every
// limiter downstream (the rate limiter, the exec bridge) reads it back with
// ClientIP. It is mounted once, on the root router.
//
// With no trusted proxies configured the client IP is the connection's
// RemoteAddr and X-Forwarded-For is ignored: the header is client-supplied, so
// trusting it by default would let anyone win a fresh rate-limit bucket per
// request simply by varying it. Operators who terminate in front of
// kube-console name their proxy CIDRs explicitly, and only then is XFF walked
// (right to left, skipping trusted hops).
//
// The peer itself is checked against those same CIDRs first, because
// chi's ClientIPFromXFF looks only at the header: a connection that did *not*
// come through the proxy would otherwise get to name its own limiter key, and
// a Service/NodePort/port-forward reaching the pod directly is exactly the
// traffic the limits exist for. Off-proxy connections are keyed by RemoteAddr.
func ClientIPResolver(trustedProxies []string) func(http.Handler) http.Handler {
	if len(trustedProxies) == 0 {
		return middleware.ClientIPFromRemoteAddr
	}
	// Prefixes are validated in config.validate, so this cannot panic.
	prefixes := make([]netip.Prefix, len(trustedProxies))
	for i, p := range trustedProxies {
		prefixes[i] = netip.MustParsePrefix(p)
	}
	fromXFF := middleware.ClientIPFromXFF(trustedProxies...)
	return func(next http.Handler) http.Handler {
		viaProxy := fromXFF(next)
		direct := middleware.ClientIPFromRemoteAddr(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if peerIn(r.RemoteAddr, prefixes) {
				viaProxy.ServeHTTP(w, r)
				return
			}
			direct.ServeHTTP(w, r)
		})
	}
}

// peerIn reports whether the connection's own address falls inside one of the
// trusted prefixes. v4-mapped addresses are unmapped first: netip.Prefix
// deliberately refuses to match those, and either notation must resolve the
// same way or one of them would alias past the check.
func peerIn(remoteAddr string, prefixes []netip.Prefix) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr // RemoteAddr may already be a bare IP (e.g. in tests).
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	ip = ip.Unmap().WithZone("")
	for _, p := range prefixes {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// ClientIP returns the resolved client IP for r, canonicalized for use as a
// limiter key: IPv6 is bucketed by /64, since a single client typically
// controls a whole /64 and could otherwise rotate within it for a fresh bucket
// per request. It falls back to RemoteAddr when the resolver stored nothing —
// with trusted proxies configured that means a request which did not come
// through the proxy, and it must still be keyed by something narrower than one
// bucket for the whole internet.
func ClientIP(r *http.Request) string {
	ip := middleware.GetClientIP(r.Context())
	if ip == "" {
		var err error
		if ip, _, err = net.SplitHostPort(r.RemoteAddr); err != nil {
			ip = r.RemoteAddr
		}
	}
	return httprate.CanonicalizeIP(ip)
}
