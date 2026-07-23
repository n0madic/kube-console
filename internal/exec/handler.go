package exec

import (
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/httpx"
	"github.com/n0madic/kube-console/internal/kube"
)

// handshakePoolFactor sizes the pending pool relative to MaxExecSessions. The
// pool only has to absorb the connections that are mid-handshake at any moment
// — each lives at most authTimeout — so a small multiple of the session limit
// is generous for real users while still bounding the goroutines and buffers a
// flood can pin.
const handshakePoolFactor = 2

// Handler serves GET /api/ui/exec/ws.
type Handler struct {
	registry       *kube.Registry
	logger         *slog.Logger
	enabled        bool
	originPatterns []string
	// pending holds connections that have not sent a valid auth frame yet;
	// sessions holds the ones that have. Splitting the two is what keeps an
	// unauthenticated flood from denying exec to authenticated users: a
	// connection occupies a session slot only once it has named a cluster, a
	// pod and a token, and it is promoted between the pools in one step.
	pending  chan struct{}
	sessions chan struct{}
	// handshakes bounds pending connections per client IP. Established
	// sessions are deliberately *not* keyed by IP: behind a reverse proxy
	// without trusted-proxy configuration every user shares one address, and
	// capping their open terminals would break the console for a whole team.
	handshakes      *ipGate
	idleTimeout     time.Duration
	authTimeout     time.Duration
	drainTimeout    time.Duration
	executorFactory ExecutorFactory
}

// NewHandler builds the exec bridge handler.
func NewHandler(reg *kube.Registry, cfg *config.Config, logger *slog.Logger) *Handler {
	return &Handler{
		registry:       reg,
		logger:         logger,
		enabled:        cfg.ExecEnabled,
		originPatterns: toOriginPatterns(cfg.AllowedOrigins),
		pending:        make(chan struct{}, handshakePoolFactor*cfg.MaxExecSessions),
		sessions:       make(chan struct{}, cfg.MaxExecSessions),
		handshakes:     newIPGate(cfg.MaxExecHandshakesPerIP),
		idleTimeout:    cfg.ExecIdleTimeout,
		// Short: the browser sends the auth frame immediately after the
		// upgrade. Every second of slack here is a second an unauthenticated
		// connection can sit in the pending pool.
		authTimeout: 2 * time.Second,
		// How long a gone browser's command may take to exit on stdin EOF
		// before the session is cancelled outright (see awaitStream). Short:
		// a command that ends on EOF does so in milliseconds, and an
		// interactive shell on a TTY never does, so the wait is pure delay
		// before the connection has to be dropped anyway.
		drainTimeout:    2 * time.Second,
		executorFactory: defaultExecutorFactory,
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.enabled {
		httpx.WriteError(w, http.StatusNotFound, "NotFound", "exec is disabled")
		return
	}
	// An unauthenticated connection is admitted into the pending pool only —
	// never into a session slot — so a handshake flood cannot take exec away
	// from users who are already signed in.
	ip := httpx.ClientIP(r)
	if !h.handshakes.acquire(ip) {
		httpx.WriteError(w, http.StatusTooManyRequests, "TooManyRequests",
			"too many exec connections from this client")
		return
	}
	select {
	case h.pending <- struct{}{}:
	default:
		h.handshakes.release(ip)
		httpx.WriteError(w, http.StatusServiceUnavailable, "ServiceUnavailable", "exec handshake capacity reached")
		return
	}
	// Released either when the connection is promoted to a session slot or
	// when it ends without ever getting there.
	releaseHandshake := sync.OnceFunc(func() {
		<-h.pending
		h.handshakes.release(ip)
	})
	defer releaseHandshake()

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Same-origin is accepted by default; OriginPatterns adds the
		// configured dev/extra origins (host[:port] patterns).
		OriginPatterns: h.originPatterns,
	})
	if err != nil {
		// Accept has already written an HTTP error (e.g. 403 bad origin).
		h.logger.Warn("exec websocket accept failed", "error", err)
		return
	}
	h.session(r.Context(), conn, releaseHandshake)
}

// toOriginPatterns converts configured origins (which may include a scheme,
// e.g. http://localhost:5173) into the host[:port] patterns Accept expects.
func toOriginPatterns(origins []string) []string {
	var out []string
	for _, o := range origins {
		if u, err := url.Parse(o); err == nil && u.Host != "" {
			out = append(out, u.Host)
			continue
		}
		out = append(out, strings.TrimSuffix(o, "/"))
	}
	return out
}
