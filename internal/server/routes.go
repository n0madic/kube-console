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

// probePaths are the kubelet-facing endpoints registered in NewHandler, kept
// beside their routes so the set RequestLogger demotes to Debug cannot name a
// path this router does not serve.
var probePaths = map[string]bool{"/healthz": true, "/readyz": true}

// NewHandler builds the full HTTP handler tree.
func NewHandler(d Deps) http.Handler {
	if d.ShutdownCtx == nil {
		d.ShutdownCtx = context.Background()
	}
	r := chi.NewRouter()
	// RequestLogger is outermost and logs from a defer, so the line survives
	// even http.ErrAbortHandler — the one panic Recoverer deliberately
	// re-panics, and how every stream the ReverseProxy aborts ends. For
	// ordinary panics Recoverer, nested inside, converts them into a 500 on the
	// same statusWriter before the deferred log records the status.
	r.Use(RequestLogger(d.Logger))
	r.Use(Recoverer(d.Logger))
	// Ahead of RequireLoopbackHost, so that the one response this server writes
	// specifically *for* an attacker's page carries them too: the fence answers
	// from its own wrapper and never reaches the handler below it, so mounted
	// second it served its 403 with no CSP, no nosniff and no frame-ancestors —
	// on the endpoint whose entire purpose is DNS-rebinding defence.
	r.Use(SecurityHeaders)
	// The credential carve-out's second fence, and the one the listen address
	// cannot provide: without it, DNS rebinding turns any page the developer
	// visits into a full-privilege client of this port. See RequireLoopbackHost.
	//
	// Asked of the registry alone, like every other credential-mode decision (the
	// auth-mode endpoint, Registry.RequireToken, the exec auth frame, the
	// gateway's Authorization strip): the registry reports what RESTConfigs
	// actually *did* with each config, while the flag is only what was asked for
	// — and RESTConfigs honours it on the kubeconfig branch alone. So the
	// registry is authoritative in both directions. Credentialed upstreams always
	// mount the fence whatever the Config beside them says, and an anonymized
	// upstream does not need it: its requests carry the user's own bearer, and
	// mounting it there would fence off a deployment that is allowed to be
	// remote. server.Run rejects a disagreement between the two at startup, so
	// this cannot quietly become half a mode.
	if d.Registry.UsesConfigCredentials() {
		r.Use(RequireLoopbackHost)
	}
	// A client that stops reading must not be able to hold a handler, its
	// in-flight slot and its upstream connection open forever. Per-write, not
	// per-response: an idle watch performs no write and is never affected.
	r.Use(WriteDeadline(d.Cfg.ResponseWriteTimeout, d.Logger))
	// The read-side counterpart, root-mounted for the same reason: net/http
	// drains up to 256KiB of unread body after ANY handler returns, before the
	// response headers go out, so a slow-dripped POST to an /api adapter or the
	// SPA fallback holds a connection just as well as one to the gateway.
	r.Use(bodyReadDeadline(d.Cfg.BodyReadTimeout))
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

	// Both consumers below need the same verdict about the same request, so it is
	// resolved once here and read from the context by each. Mounted inside the
	// rate limit, so a shed request never pays for the classification, and
	// outside both consumers, since only a value set ahead of them is visible to
	// them (wrapping is inside-out: the last wrap runs first).
	streaming := newStreamClassifier(gateway.IsStreaming)

	gw := maxBody(d.Cfg.MaxBodyBytes, gateway.New(d.Registry, d.Logger))
	gw = AbortOnShutdown(d.ShutdownCtx, streaming.verdict)(gw)
	gw = inFlight.middleware(streaming.verdict)(gw)
	gw = streaming.middleware(gw)
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
// gateway error handler. Gateway-scoped deliberately, unlike bodyReadDeadline
// on the root router: /k8s/* is the only place a client body is read and
// forwarded upstream, the one body-bearing /api/ui route (auth verify) never
// reads its body at all, and net/http's post-handler drain reads the raw
// connection underneath MaxBytesReader — so a wider mount would bound nothing.
func maxBody(limit int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, limit)
		}
		next.ServeHTTP(w, r)
	})
}

// bodyReadDeadline bounds how long a slow client may take to send a request
// body, via a per-request read deadline (ResponseController). It must cover
// every route, not just the gateway: net/http drains an unread body after the
// handler returns and before the response headers go out, with no ReadTimeout
// behind it — so without the deadline a body dripped at a few bytes per second
// holds the connection and its goroutine for hours on any POST path,
// authenticated or not. GET/watch/log requests carry no body and stream their
// response for a long time, so they are deliberately left untouched —
// SetReadDeadline only affects reading from the client, never the response.
//
// A zero (or negative) timeout disables the middleware entirely.
func bodyReadDeadline(timeout time.Duration) func(http.Handler) http.Handler {
	if timeout <= 0 {
		return func(next http.Handler) http.Handler { return next }
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if methodHasBody(r.Method) {
				// Best-effort: on transports without deadline support this
				// errors out and MaxBytesReader remains the only body guard.
				_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(timeout))
			}
			next.ServeHTTP(w, r)
		})
	}
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
