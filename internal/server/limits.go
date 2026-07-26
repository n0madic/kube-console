package server

import (
	"context"
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

// streamClassifier resolves a per-request predicate once and shares the verdict
// with every middleware that needs it. On /k8s/* two of them ask the same
// question of the same request — AbortOnShutdown, to decide whether to cancel
// the moment shutdown starts, and the in-flight cap, to pick a pool — and
// nothing mounted between them can change the answer. The question is not free:
// gateway.IsStreaming parses the query string and, on a miss, walks the path
// segments looking for the deprecated legacy-watch prefix, so asking twice pays
// for all of that twice on every proxied request, watches and unary alike.
type streamClassifier struct{ match func(*http.Request) bool }

// streamingCtxKey keys the resolved verdict on the request context. An
// unexported struct type, not a string: no other package can collide with it or
// reach the value by guessing a name.
type streamingCtxKey struct{}

func newStreamClassifier(match func(*http.Request) bool) *streamClassifier {
	return &streamClassifier{match: match}
}

// middleware evaluates the predicate once and stores the verdict on the request
// context. It has to be mounted outside every consumer of verdict — the derived
// contexts they build inherit values (AbortOnShutdown's context.WithCancelCause
// included), so one value set out here is visible all the way in, but a value
// set inside a consumer is invisible to it.
func (c *streamClassifier) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		streaming := c.match != nil && c.match(r)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), streamingCtxKey{}, streaming)))
	})
}

// verdict reports whether r is long-lived: the cached answer when the classifier
// ran ahead of the caller, a fresh evaluation of the predicate otherwise.
//
// That fallback is load-bearing, not defensive tidiness. It is what keeps this
// an optimization instead of a way out of the in-flight cap: "long-lived" is
// decided by a client-supplied query parameter, so the cap must never become
// opt-out, and without the fallback a route that mounted a consumer with no
// classifier in front of it would classify every request by the zero value —
// either sending watches into the small unary pool, where each one pins a slot
// for as long as the page stays open, or (had the default gone the other way)
// waving everything through the loose stream pool, which is the opt-out itself.
// The /api subrouter mounts the cap with its own cheap isExecWS predicate and no
// classifier, so this is a live path, not a hypothetical one.
//
// The value is per-request and lives only on that request's context. Do not add
// a cross-request cache keyed by path or query: recomputing is cheap, and a
// shared verdict keyed by client-supplied input would be a second source of
// truth for what streams.
func (c *streamClassifier) verdict(r *http.Request) bool {
	if v, ok := r.Context().Value(streamingCtxKey{}).(bool); ok {
		return v
	}
	return c.match != nil && c.match(r)
}

// isExecWS reports whether r targets the exec WebSocket bridge, which holds its
// connection open for the life of a terminal and enforces its own limits. The
// prefix is derived from the route registration, not spelled out again: a moved
// route would otherwise silently start spending unary slots for hours.
func isExecWS(r *http.Request) bool {
	return strings.HasPrefix(r.URL.Path, execWSPath+"/") || r.URL.Path == execWSPath
}
