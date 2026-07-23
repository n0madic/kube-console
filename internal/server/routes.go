package server

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/gateway"
	"github.com/n0madic/kube-console/internal/httpx"
	"github.com/n0madic/kube-console/internal/kube"
)

// Deps carries everything the router needs.
type Deps struct {
	Cfg      *config.Config
	Registry *kube.Registry
	Logger   *slog.Logger
	Version  string
	DistFS   fs.FS
	// ShutdownCtx is done exactly when the process starts shutting down (the
	// same context Run selects on). Long-lived requests (watch, log follow,
	// exec) are wrapped with AbortOnShutdown against it so they abort
	// immediately instead of blocking srv.Shutdown() for its full grace period.
	ShutdownCtx context.Context
}

// NewHandler builds the full HTTP handler tree.
func NewHandler(d Deps) http.Handler {
	if d.ShutdownCtx == nil {
		d.ShutdownCtx = context.Background()
	}
	r := chi.NewRouter()
	// RequestLogger is outermost so it logs even panicked requests: Recoverer,
	// nested inside, converts the panic into a 500 on the same statusWriter
	// before control returns to the logger. (RequestLogger records the status
	// after next.ServeHTTP returns, so a panic escaping it would be unlogged.)
	r.Use(RequestLogger(d.Logger))
	r.Use(Recoverer(d.Logger))
	r.Use(SecurityHeaders)
	// A client that stops reading must not be able to hold a handler, its
	// in-flight slot and its upstream connection open forever. Per-write, not
	// per-response: an idle watch performs no write and is never affected.
	r.Use(WriteDeadline(d.Cfg.ResponseWriteTimeout, d.Logger))
	// Resolves the client IP once for every limiter downstream (rate limit,
	// exec handshakes).
	r.Use(httpx.ClientIPResolver(d.Cfg.TrustedProxies))

	r.Get("/healthz", handleHealthz(d.Version))
	// Readiness probes the default context; a single reachable apiserver is
	// enough to report ready. The result is cached so probe traffic — which is
	// unauthenticated — cannot be replayed into the apiserver one-for-one.
	r.Get("/readyz", newReadinessCache(d.Registry.Default(), readinessTTL).handler)

	// Both limiters are shared by every proxied path: one per-client budget and
	// one global concurrency cap, so /k8s/* and /api/ui/* cannot be alternated
	// to spend either twice. They are outermost, ahead of body limits and
	// upstream dispatch, so a shed request costs nothing but the check.
	limiter := newRateLimiter(d.Cfg)
	inFlight := newInFlightLimiter(d.Cfg.MaxInFlight)

	gw := maxBody(d.Cfg.MaxBodyBytes, d.Cfg.BodyReadTimeout, gateway.New(d.Registry, d.Logger))
	gw = AbortOnShutdown(d.ShutdownCtx, gateway.IsStreaming)(gw)
	gw = inFlight.middleware(gateway.IsStreaming)(gw)
	gw = rateLimit(limiter)(gw)
	r.Handle("/k8s", gw)
	r.Handle("/k8s/*", gw)

	r.Route("/api", func(api chi.Router) {
		api.Use(rateLimit(limiter))
		api.Use(inFlight.middleware(isExecWS))
		api.NotFound(func(w http.ResponseWriter, r *http.Request) {
			httpx.WriteError(w, http.StatusNotFound, "NotFound", "not found")
		})
		api.Route("/ui", func(ui chi.Router) {
			registerUI(ui, d)
		})
	})

	r.NotFound(NewSPAHandler(d.DistFS).ServeHTTP)
	return r
}

func handleHealthz(version string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": version})
	}
}

// maxBody caps request bodies; exceeding it surfaces as a JSON 413 via the
// gateway error handler. It also bounds how long a slow client may take to
// send the body: for body-bearing methods it sets a per-request read deadline
// via ResponseController. GET/watch/log requests carry no body and stream
// their response for a long time, so they are deliberately left untouched —
// SetReadDeadline only affects reading from the client, never the response.
func maxBody(limit int64, bodyTimeout time.Duration, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, limit)
		}
		if bodyTimeout > 0 && methodHasBody(r.Method) {
			// Best-effort: on transports without deadline support this errors
			// out and MaxBytesReader remains the only body guard.
			_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(bodyTimeout))
		}
		next.ServeHTTP(w, r)
	})
}

// methodHasBody reports whether the HTTP method typically carries a request
// body that a slow client could drip-feed. Watch/log are GET and excluded.
func methodHasBody(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}
