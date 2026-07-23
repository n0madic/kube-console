package server

import (
	"net/http"
	"strings"

	"github.com/go-chi/httprate"

	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/httpx"
)

func clientIPKey(r *http.Request) (string, error) { return httpx.ClientIP(r), nil }

// newRateLimiter builds the shared per-client limiter, or nil when disabled.
// One limiter instance is shared by /k8s/* and /api/ui/*, so a client cannot
// spend the same budget twice by alternating between them.
func newRateLimiter(cfg *config.Config) *httprate.RateLimiter {
	if cfg.RateLimit <= 0 {
		return nil
	}
	return httprate.NewRateLimiter(cfg.RateLimit, config.RateLimitWindow,
		httprate.WithKeyFuncs(clientIPKey),
		httprate.WithLimitHandler(func(w http.ResponseWriter, r *http.Request) {
			// Same shape and reason the apiserver itself uses when it sheds
			// load, so the SPA needs no special case. httprate has already set
			// Retry-After and the X-RateLimit-* headers.
			httpx.WriteError(w, http.StatusTooManyRequests, "TooManyRequests", "too many requests; retry later")
		}),
	)
}

// rateLimit adapts a possibly-nil limiter into a middleware.
func rateLimit(l *httprate.RateLimiter) func(http.Handler) http.Handler {
	if l == nil {
		return func(next http.Handler) http.Handler { return next }
	}
	return l.Handler
}

// streamPoolFactor sizes the long-lived pool relative to MaxInFlight. Streams
// need their own, far looser pool rather than the unary one: a watch or a log
// follow lives as long as the user keeps the page open, so counting it against
// MaxInFlight would fill the cap with idle streams and starve the short
// requests it exists to protect. Exempting them outright is not an option
// either — "long-lived" is decided by a client-supplied query parameter
// (`?watch=true`), so anyone could opt out of the cap by typing it.
const streamPoolFactor = 8

// inFlightLimiter caps how many requests may be in an upstream call at once,
// across all clients. It is the backstop the per-client rate limit cannot
// provide: a distributed flood stays under every individual budget while still
// piling unbounded concurrent work onto the apiserver — and the rate limit
// bounds only the rate, so unbounded *concurrency* accumulates under it.
type inFlightLimiter struct {
	slots   chan struct{}
	streams chan struct{}
}

// newInFlightLimiter returns nil (a no-op) when the cap is disabled.
func newInFlightLimiter(max int) *inFlightLimiter {
	if max <= 0 {
		return nil
	}
	return &inFlightLimiter{
		slots:   make(chan struct{}, max),
		streams: make(chan struct{}, streamPoolFactor*max),
	}
}

// middleware occupies one slot for the duration of each request: the unary pool
// normally, the much larger stream pool for requests matched by longLived.
func (l *inFlightLimiter) middleware(longLived func(*http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if l == nil {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			pool := l.slots
			if longLived != nil && longLived(r) {
				pool = l.streams
			}
			select {
			case pool <- struct{}{}:
				defer func() { <-pool }()
			default:
				w.Header().Set("Retry-After", "1")
				httpx.WriteError(w, http.StatusTooManyRequests, "TooManyRequests",
					"too many concurrent requests; retry later")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// isExecWS reports whether r targets the exec WebSocket bridge, which holds its
// connection open for the life of a terminal and enforces its own limits. The
// prefix is derived from the route registration, not spelled out again: a moved
// route would otherwise silently start spending unary slots for hours.
func isExecWS(r *http.Request) bool {
	return strings.HasPrefix(r.URL.Path, execWSPath+"/") || r.URL.Path == execWSPath
}
