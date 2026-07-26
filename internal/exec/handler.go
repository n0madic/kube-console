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
	handshakes  *ipGate
	idleTimeout time.Duration
	authTimeout time.Duration
	// idleFrameTimeout bounds how long the idle timeout waits for its own
	// explanation to reach the browser before ending the session regardless —
	// see reportIdleTimeout.
	idleFrameTimeout time.Duration
	drainTimeout     time.Duration
	// stdinBufferLimit caps stdin staged between readLoop and stdinPump; see
	// stdinQueue. pingInterval/pingTimeout drive the keepalive. All three are
	// fields rather than constants so tests can drive them at speeds a real
	// terminal never sees.
	stdinBufferLimit int
	pingInterval     time.Duration
	pingTimeout      time.Duration
	executorFactory  ExecutorFactory
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
		// The idle timeout's error frame is best-effort: a healthy connection
		// takes it instantly, and one whose writes are stalled is not going to
		// read it at all. Short, because every millisecond of it is delay before
		// a session that has to end anyway actually releases its slot.
		idleFrameTimeout: time.Second,
		// How long a gone browser's command may take to exit on stdin EOF
		// before the session is cancelled outright (see awaitStream). Short:
		// a command that ends on EOF does so in milliseconds, and an
		// interactive shell on a TTY never does, so the wait is pure delay
		// before the connection has to be dropped anyway.
		drainTimeout:     2 * time.Second,
		stdinBufferLimit: stdinBufferLimitBytes,
		// A ping every 30s with 10s to answer. Receiving the pong needs a
		// concurrent Reader, so these bound how long readLoop may be away from
		// conn.Read before a healthy session is torn down as unresponsive —
		// which is why the stdin handoff must never block.
		pingInterval:    30 * time.Second,
		pingTimeout:     10 * time.Second,
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
		// Accept has already written an HTTP error (e.g. 403 bad origin), and
		// err is deliberately not logged: coder/websocket builds these messages
		// out of inbound header values (Origin, Host, Connection, Upgrade,
		// Sec-WebSocket-Version, Sec-WebSocket-Key), and this endpoint is
		// pre-auth and unmetered by default, so logging it would put
		// client-controlled text in the log at whatever volume a caller likes.
		h.logger.Warn("exec websocket accept failed", "client", ip)
		return
	}
	// Accept has hijacked the connection, so net/http will never close it for us
	// and Recoverer cannot answer on it either (writing to a hijacked
	// ResponseWriter returns ErrHijacked). session() closes it on every ordinary
	// return path; this covers the one that is not ordinary — a panic before the
	// read loop owns the socket would otherwise leak the fd and
	// coder/websocket's timeout goroutine for the life of the process. CloseNow
	// is a no-op once the connection is already closed.
	defer func() { _ = conn.CloseNow() }()
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
