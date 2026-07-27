// Package server wires the HTTP server: routing, middleware, static SPA
// serving and lifecycle.
package server

import (
	"bufio"
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"runtime/debug"
	"strings"
	"sync/atomic"
	"time"

	"github.com/n0madic/kube-console/internal/httpx"
)

// csp allows only same-origin content. style-src needs 'unsafe-inline'
// because xterm.js, uPlot and CodeMirror inject runtime <style> elements;
// script-src stays strict. Documented tradeoff in README.
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; " +
	"frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

// SecurityHeaders sets the production security headers on every response.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()")
		next.ServeHTTP(w, r)
	})
}

// RequireLoopbackHost rejects any request whose Host header does not name the
// loopback interface. It is mounted **only** in --use-kubeconfig-credentials
// mode, where it closes the hole the loopback listen address alone leaves open:
// DNS rebinding.
//
// Binding 127.0.0.1 stops other machines from connecting, but it does not stop
// the developer's own browser from being aimed at it. A page on evil.example
// whose DNS record is rebound to 127.0.0.1 reaches this listener with Host and
// Origin both "evil.example" — so the request is same-origin, CORS never
// applies, and coder/websocket's default origin check (which compares Origin
// against Host) passes too. Without a Host check, every site the developer
// visits could read Secrets and open a shell in any pod as the kubeconfig's
// owner. This is exactly why `kubectl proxy` ships --accept-hosts defaulting to
// localhost/127.0.0.1/[::1], and this is that check.
//
// The token mode does not need it: there a request without the user's bearer
// token gets nothing but a 401 from the apiserver.
func RequireLoopbackHost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackHost(r.Host) {
			httpx.WriteError(w, http.StatusForbidden, "Forbidden",
				"kube-console is reachable on loopback names only in this mode")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// isLoopbackHost reports whether a Host header value names the loopback
// interface: "localhost" exactly (never a suffix like "localhost.evil.example")
// or a loopback IP literal, with or without a port.
func isLoopbackHost(host string) bool {
	name := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		name = h
	}
	if strings.EqualFold(name, "localhost") {
		return true
	}
	// An IPv6 literal keeps its brackets when there is no port to split off.
	name = strings.TrimSuffix(strings.TrimPrefix(name, "["), "]")
	ip, err := netip.ParseAddr(name)
	return err == nil && ip.IsLoopback()
}

// RequestLogger logs method, path, status and duration. It never logs
// headers, bodies or query strings: for /k8s/* and /api/ui/* the query may
// contain sensitive selectors and the headers carry the user token.
func RequestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sw := &statusWriter{ResponseWriter: w}
			// Deferred so the line survives http.ErrAbortHandler, which
			// Recoverer re-panics and net/http then swallows: logging on the
			// return path would leave every stream the ReverseProxy aborts —
			// a closed tab on a watch or log follow — with no trace at all.
			defer func() {
				status := sw.Status()
				logger.Log(r.Context(), requestLogLevel(r.URL.Path, status), "request",
					"method", r.Method,
					"path", r.URL.Path,
					"status", status,
					"duration_ms", time.Since(start).Milliseconds(),
				)
			}()
			next.ServeHTTP(sw, r)
		})
	}
}

// requestLogLevel demotes *successful* probe traffic to Debug. The kubelet asks
// for /healthz and /readyz every few seconds for the life of every pod and a
// 200 there says nothing, so at Info it is all one ever sees; --log-level debug
// brings it back. A failing probe keeps Info: a /readyz answering 503 is the
// last thing logged before the pod is restarted, which is exactly when the log
// has to say why.
func requestLogLevel(path string, status int) slog.Level {
	if status < http.StatusBadRequest && probePaths[path] {
		return slog.LevelDebug
	}
	return slog.LevelInfo
}

// Recoverer converts panics into JSON 500 responses.
func Recoverer(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					if rec == http.ErrAbortHandler {
						panic(rec)
					}
					logger.Error("panic recovered",
						"method", r.Method,
						"path", r.URL.Path,
						"panic", rec,
						"stack", string(debug.Stack()),
					)
					httpx.WriteError(w, http.StatusInternalServerError, "InternalError", "internal server error")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// AbortOnShutdown cancels the request context of requests selected by match
// as soon as shutdown is done, instead of letting them ride out
// srv.Shutdown()'s fixed grace period. Without this, a long-lived request
// (a Kubernetes watch, a log follow, an exec session) blocks Shutdown() until
// its timeout, at which point srv.Close() force-closes every connection
// indiscriminately — including unrelated short requests still in flight.
// match == nil treats every request as long-lived (e.g. exec, which is
// inherently a persistent session).
//
// The shutdown branch cancels with httpx.ErrShutdown as the cause: from
// ctx.Err() a shutdown abort and a departed client are the same
// context.Canceled, yet they need opposite responses — a client that is still
// connected must be told the stream failed, or net/http completes the response
// as an empty 200 that a watch client reads as a clean end of stream.
// Consumers compare context.Cause(ctx); the deferred cleanup cancel keeps the
// ordinary meaning (plain context.Canceled), so a normal completion never
// reads as a shutdown.
func AbortOnShutdown(shutdown context.Context, match func(*http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if match != nil && !match(r) {
				next.ServeHTTP(w, r)
				return
			}
			ctx, cancel := context.WithCancelCause(r.Context())
			defer cancel(nil)
			go func() {
				select {
				case <-shutdown.Done():
					cancel(httpx.ErrShutdown)
				case <-ctx.Done():
				}
			}()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// WriteDeadline bounds how long a single write to the client may stall. The
// deadline is re-armed before every write instead of being set once for the
// response, which is what makes it safe for the long-lived paths: an idle
// watch or log follow performs no write at all, so nothing is ever armed,
// while a large non-streaming download only has to keep making progress. An
// http.Server WriteTimeout could not express that — it bounds the whole
// response and would cut streams off. Without any bound, a client that stops
// reading parks the handler in Write forever, holding its in-flight slot and
// its upstream connection.
//
// A zero (or negative) timeout disables the middleware entirely.
func WriteDeadline(timeout time.Duration, logger *slog.Logger) func(http.Handler) http.Handler {
	if timeout <= 0 {
		return func(next http.Handler) http.Handler { return next }
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			dw := &deadlineWriter{
				ResponseWriter: w,
				rc:             http.NewResponseController(w),
				timeout:        timeout,
				logger:         logger,
				req:            r,
			}
			// finish must run on the panic path too: a stalled write makes the
			// ReverseProxy abort with http.ErrAbortHandler, which Recoverer
			// re-panics.
			defer dw.finish()
			next.ServeHTTP(dw, r)
		})
	}
}

// deadlineWriter re-arms the connection's write deadline around every write to
// the client, and hands it back untouched once the connection is hijacked.
type deadlineWriter struct {
	http.ResponseWriter
	rc      *http.ResponseController
	timeout time.Duration
	logger  *slog.Logger
	req     *http.Request

	// deadline is the one currently armed on the connection; arm reuses it
	// while most of the budget is still ahead.
	deadline time.Time
	reported atomic.Bool
	hijacked atomic.Bool
}

// arm makes sure a deadline covering this write is in force. It is best-effort,
// as in bodyReadDeadline: on a transport without deadline support
// SetWriteDeadline errors out and the write simply stays unbounded.
//
// Re-arming is skipped while more than half the budget is still ahead of the
// armed deadline. Setting one costs a syscall that takes the fd lock and resets
// a runtime timer, and the requirement is only that the client keeps making
// progress — paying it per 32KiB proxy chunk would double the per-write kernel
// work on the copy path for nothing. The effective bound on a stalled write is
// therefore anywhere in [timeout/2, timeout].
func (w *deadlineWriter) arm() {
	now := time.Now()
	if now.Add(w.timeout / 2).Before(w.deadline) {
		return
	}
	w.deadline = now.Add(w.timeout)
	_ = w.rc.SetWriteDeadline(w.deadline)
}

func (w *deadlineWriter) WriteHeader(code int) {
	w.arm()
	w.ResponseWriter.WriteHeader(code)
}

func (w *deadlineWriter) Write(b []byte) (int, error) {
	w.arm()
	n, err := w.ResponseWriter.Write(b)
	if err != nil && errors.Is(err, os.ErrDeadlineExceeded) {
		w.reportTimeout()
	}
	return n, err
}

// reportTimeout states, once per response, that we dropped this client. The
// abort path is otherwise completely silent: a stalled write makes the
// ReverseProxy panic with http.ErrAbortHandler, which Recoverer re-panics and
// net/http swallows, while RequestLogger only logs after ServeHTTP returns — so
// a request the server itself killed would leave no trace at all. Method and
// path only, never headers, bodies or query strings.
func (w *deadlineWriter) reportTimeout() {
	if w.logger == nil || !w.reported.CompareAndSwap(false, true) {
		return
	}
	w.logger.Warn("client stopped reading; write deadline exceeded",
		"method", w.req.Method,
		"path", w.req.URL.Path,
		"timeout_ms", w.timeout.Milliseconds(),
	)
}

// FlushError arms as well. A flush is where buffered bytes actually reach the
// socket, and it is not always preceded by a write in the same breath: the
// ReverseProxy flushes inline only because the gateway sets FlushInterval -1,
// while any positive interval flushes from a timer goroutine instead. Without
// arming here, such a flush would run under whatever deadline the last write
// left behind — expired, after an idle stream.
//
// It exists alongside Flush because http.ResponseController.Flush matches
// interface{ FlushError() error } before http.Flusher: a wrapper exposing only
// the bare Flush would swallow the flush's error, and when the upstream
// produces nothing after a stalled flush that error is the only place the
// write timeout ever surfaces — hence reportTimeout here too.
func (w *deadlineWriter) FlushError() error {
	w.arm()
	err := flushError(w.ResponseWriter)
	if err != nil && errors.Is(err, os.ErrDeadlineExceeded) {
		w.reportTimeout()
	}
	return err
}

func (w *deadlineWriter) Flush() {
	_ = w.FlushError()
}

// Hijack disarms only *after* the hijack has happened. net/http's
// (*response).Hijack flushes the already-written 101 to the socket before
// handing the connection over, and that write has to stay guarded — clearing
// the deadline first would park the handler in exactly the stall this
// middleware exists to prevent. net/http then clears both deadlines itself
// (hijackLocked), so this is belt-and-braces on the connection we are handed:
// it keeps the guarantee — the terminal's lifetime is the WebSocket's business,
// not ours — independent of that internal detail.
func (w *deadlineWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		return conn, rw, err
	}
	w.hijacked.Store(true)
	if conn != nil {
		_ = conn.SetWriteDeadline(time.Time{})
	}
	return conn, rw, nil
}

// finish runs when the handler returns, before net/http finishes the response,
// and re-arms: net/http's own end-of-response flush (finishRequest, which
// writes the chunked terminator) happens after this point and before the server
// resets the deadline. A stream that idled longer than the timeout would
// otherwise hit that flush with a long-expired deadline — the terminator fails
// with i/o timeout and the client sees a truncated body instead of a clean end,
// making every quiet watch and log follow end in an error.
func (w *deadlineWriter) finish() {
	if w.hijacked.Load() {
		// The connection belongs to the WebSocket now; net/http will not write
		// anything more on it and neither may we.
		return
	}
	w.arm()
}

func (w *deadlineWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// flushError flushes w, preferring its FlushError so the error is not lost,
// falling back to Flusher, and reporting ErrNotSupported — as
// ResponseController would — when w can do neither.
func flushError(w http.ResponseWriter) error {
	switch f := w.(type) {
	case interface{ FlushError() error }:
		return f.FlushError()
	case http.Flusher:
		f.Flush()
		return nil
	default:
		return http.ErrNotSupported
	}
}

// statusWriter records the response status while remaining compatible with
// streaming (Flush) and WebSocket upgrades (Hijack/Unwrap).
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Status() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

// FlushError mirrors deadlineWriter's: ResponseController.Flush prefers it
// over Flusher, so without it this layer would drop a flush error the writers
// below can report.
func (w *statusWriter) FlushError() error {
	return flushError(w.ResponseWriter)
}

func (w *statusWriter) Flush() {
	_ = w.FlushError()
}

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := w.ResponseWriter.(http.Hijacker); ok {
		conn, rw, err := hj.Hijack()
		if err == nil && w.status == 0 {
			w.status = http.StatusSwitchingProtocols
		}
		return conn, rw, err
	}
	return nil, nil, http.ErrNotSupported
}

func (w *statusWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}
