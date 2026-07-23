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
	"os"
	"runtime/debug"
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

// RequestLogger logs method, path, status and duration. It never logs
// headers, bodies or query strings: for /k8s/* and /api/ui/* the query may
// contain sensitive selectors and the headers carry the user token.
func RequestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sw := &statusWriter{ResponseWriter: w}
			next.ServeHTTP(sw, r)
			logger.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", sw.Status(),
				"duration_ms", time.Since(start).Milliseconds(),
			)
		})
	}
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
func AbortOnShutdown(shutdown context.Context, match func(*http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if match != nil && !match(r) {
				next.ServeHTTP(w, r)
				return
			}
			ctx, cancel := context.WithCancel(r.Context())
			defer cancel()
			go func() {
				select {
				case <-shutdown.Done():
					cancel()
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
// as in maxBody: on a transport without deadline support SetWriteDeadline
// errors out and the write simply stays unbounded.
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

// Flush arms as well. A flush is where buffered bytes actually reach the
// socket, and it is not always preceded by a write in the same breath: the
// ReverseProxy flushes inline only because the gateway sets FlushInterval -1,
// while any positive interval flushes from a timer goroutine instead. Without
// arming here, such a flush would run under whatever deadline the last write
// left behind — expired, after an idle stream.
func (w *deadlineWriter) Flush() {
	w.arm()
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
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

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
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
