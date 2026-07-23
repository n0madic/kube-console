package server

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestRequestLoggerNeverLogsTokenOrQuery(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, nil))
	const sentinel = "SENTINEL-secret-token"

	handler := RequestLogger(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet,
		"/k8s/api/v1/secrets?fieldSelector=metadata.name%3D"+sentinel+"&watch=true", nil)
	req.Header.Set("Authorization", "Bearer "+sentinel)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	req2 := httptest.NewRequest(http.MethodPost, "/api/ui/auth/verify?t="+sentinel, nil)
	req2.Header.Set("Authorization", "Bearer "+sentinel)
	handler.ServeHTTP(httptest.NewRecorder(), req2)

	logged := buf.String()
	if strings.Contains(logged, sentinel) {
		t.Fatalf("log output leaked the sentinel: %s", logged)
	}
	if strings.Contains(logged, "fieldSelector") || strings.Contains(logged, "watch=true") {
		t.Fatalf("log output leaked the query string: %s", logged)
	}
	if !strings.Contains(logged, "/k8s/api/v1/secrets") {
		t.Fatalf("log output should contain the request path: %s", logged)
	}
}

func TestSecurityHeaders(t *testing.T) {
	handler := SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	checks := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "no-referrer",
	}
	for name, want := range checks {
		if got := rec.Header().Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	csp := rec.Header().Get("Content-Security-Policy")
	for _, directive := range []string{"script-src 'self'", "frame-ancestors 'none'", "object-src 'none'"} {
		if !strings.Contains(csp, directive) {
			t.Errorf("CSP missing %q: %s", directive, csp)
		}
	}
	if rec.Header().Get("Permissions-Policy") == "" {
		t.Error("Permissions-Policy is not set")
	}
}

func TestAbortOnShutdownCancelsMatchedRequestImmediately(t *testing.T) {
	shutdown, cancelShutdown := context.WithCancel(context.Background())
	defer cancelShutdown()

	started := make(chan struct{})
	done := make(chan error, 1)
	handler := AbortOnShutdown(shutdown, func(*http.Request) bool { return true })(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			close(started)
			<-r.Context().Done()
			done <- r.Context().Err()
		}))

	go handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods?watch=true", nil))

	<-started
	cancelShutdown()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("request context should report an error after shutdown fires")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("matched (watch) request was not aborted when shutdown fired")
	}
}

func TestAbortOnShutdownLeavesUnmatchedRequestsAlone(t *testing.T) {
	shutdown, cancelShutdown := context.WithCancel(context.Background())
	cancelShutdown() // shutdown already fired before the request even arrives

	var ctxErr error
	handler := AbortOnShutdown(shutdown, func(*http.Request) bool { return false })(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctxErr = r.Context().Err()
			w.WriteHeader(http.StatusOK)
		}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods", nil))

	if ctxErr != nil {
		t.Fatalf("unmatched request's context should be untouched by shutdown, got err = %v", ctxErr)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestAbortOnShutdownNilMatchTreatsEveryRequestAsLongLived(t *testing.T) {
	shutdown, cancelShutdown := context.WithCancel(context.Background())
	defer cancelShutdown()

	started := make(chan struct{})
	done := make(chan error, 1)
	handler := AbortOnShutdown(shutdown, nil)(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			close(started)
			<-r.Context().Done()
			done <- r.Context().Err()
		}))

	go handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/ui/exec/ws", nil))

	<-started
	cancelShutdown()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("nil match should treat the request as long-lived and abort it on shutdown")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("request was not aborted when shutdown fired")
	}
}

func TestRecovererReturnsJSON500(t *testing.T) {
	logger := slog.New(slog.DiscardHandler)
	handler := Recoverer(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"Status"`) {
		t.Fatalf("body = %q, want Status JSON", rec.Body.String())
	}
}

// writeDeadlineRecorder is a ResponseWriter that supports SetWriteDeadline and
// records every deadline it is given. httptest.ResponseRecorder cannot be used
// here: it has no deadline support, so ResponseController returns
// ErrNotSupported and nothing is observable.
//
// Its Hijack returns a real net.Conn (also recording deadlines), because the
// production chain ends in (*response).Hijack, which flushes the buffered 101
// to the socket and hands back a live connection — a fake returning
// (nil, nil, nil) could not tell an implementation that disarms before that
// flush from one that disarms after.
type writeDeadlineRecorder struct {
	http.ResponseWriter
	deadlines []time.Time
	conn      *deadlineRecordingConn
}

func (w *writeDeadlineRecorder) SetWriteDeadline(t time.Time) error {
	w.deadlines = append(w.deadlines, t)
	return nil
}

func (w *writeDeadlineRecorder) last() (time.Time, bool) {
	if len(w.deadlines) == 0 {
		return time.Time{}, false
	}
	return w.deadlines[len(w.deadlines)-1], true
}

func (w *writeDeadlineRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	client, server := net.Pipe()
	w.conn = &deadlineRecordingConn{Conn: server}
	// net.Pipe is synchronous: without a reader, any write to it would block.
	go func() { _, _ = io.Copy(io.Discard, client) }()
	return w.conn, bufio.NewReadWriter(bufio.NewReader(w.conn), bufio.NewWriter(w.conn)), nil
}

// deadlineRecordingConn records the deadlines set on a hijacked connection.
type deadlineRecordingConn struct {
	net.Conn
	deadlines []time.Time
}

func (c *deadlineRecordingConn) SetWriteDeadline(t time.Time) error {
	c.deadlines = append(c.deadlines, t)
	return c.Conn.SetWriteDeadline(t)
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestWriteDeadlineArmsBeforeEachStalledWrite(t *testing.T) {
	// A timeout this short means every pause below outlives the armed deadline,
	// so each write has to arm a fresh one.
	const timeout = 2 * time.Millisecond
	handler := WriteDeadline(timeout, discardLogger())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		for range 2 {
			time.Sleep(3 * time.Millisecond)
			_, _ = w.Write([]byte("chunk"))
		}
	}))

	rec := &writeDeadlineRecorder{ResponseWriter: httptest.NewRecorder()}
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods", nil))

	if len(rec.deadlines) < 3 {
		t.Fatalf("armed %d deadlines, want at least 3 (WriteHeader + 2 writes)", len(rec.deadlines))
	}
	for i, d := range rec.deadlines {
		if d.IsZero() {
			t.Fatalf("deadline %d is the zero time, want a concrete future time", i)
		}
		if i > 0 && !d.After(rec.deadlines[i-1]) {
			t.Fatalf("deadline %d (%v) does not extend the previous one (%v): "+
				"the deadline must be re-armed per stalled write, not set once", i, d, rec.deadlines[i-1])
		}
	}
}

func TestWriteDeadlineSkipsRedundantRearm(t *testing.T) {
	// With the whole budget still ahead, the armed deadline already covers the
	// next write: re-arming would cost a syscall per proxied chunk for nothing.
	handler := WriteDeadline(time.Hour, discardLogger())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		for range 8 {
			_, _ = w.Write([]byte("chunk"))
		}
	}))

	rec := &writeDeadlineRecorder{ResponseWriter: httptest.NewRecorder()}
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods", nil))

	if len(rec.deadlines) != 1 {
		t.Fatalf("armed %d deadlines for 9 back-to-back writes, want 1", len(rec.deadlines))
	}
}

func TestWriteDeadlineRearmsForTheFinalFlush(t *testing.T) {
	// net/http writes the chunked terminator in finishRequest() after the
	// handler returns and before it resets the deadline, so an idle stream must
	// not leave an expired one behind. See the end-to-end case below.
	const timeout = 20 * time.Millisecond
	handler := WriteDeadline(timeout, discardLogger())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("event\n"))
		time.Sleep(3 * timeout)
	}))

	rec := &writeDeadlineRecorder{ResponseWriter: httptest.NewRecorder()}
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods?watch=true", nil))

	if len(rec.deadlines) != 2 {
		t.Fatalf("armed %d deadlines, want 2 (the write + the re-arm on return)", len(rec.deadlines))
	}
	if !rec.deadlines[1].After(rec.deadlines[0]) {
		t.Fatal("the deadline left in force when the handler returned is the expired one from the last write")
	}
}

func TestWriteDeadlineDisarmsAfterHijack(t *testing.T) {
	// coder/websocket's Accept writes the 101 and then hijacks. The 101 must
	// stay guarded — (*response).Hijack flushes it to the socket — while the
	// terminal that outlives the handshake must not inherit any deadline.
	handler := WriteDeadline(30*time.Second, discardLogger())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusSwitchingProtocols)
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Error("wrapped writer must still implement http.Hijacker")
			return
		}
		conn, _, err := hj.Hijack()
		if err != nil {
			t.Errorf("Hijack: %v", err)
			return
		}
		defer conn.Close()
	}))

	rec := &writeDeadlineRecorder{ResponseWriter: httptest.NewRecorder()}
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ui/exec/ws", nil))

	if rec.conn == nil {
		t.Fatal("Hijack was not forwarded to the underlying writer")
	}
	// Before the hijack: the 101 write is armed and stays armed, so the flush
	// inside (*response).Hijack cannot stall forever.
	if len(rec.deadlines) != 1 {
		t.Fatalf("armed %d deadlines on the response writer, want exactly 1 (the 101)", len(rec.deadlines))
	}
	if last, _ := rec.last(); last.IsZero() {
		t.Fatal("the deadline was cleared before the hijack, leaving the 101 flush unguarded")
	}
	// After the hijack: the connection is the WebSocket's, with no deadline.
	if len(rec.conn.deadlines) != 1 || !rec.conn.deadlines[0].IsZero() {
		t.Fatalf("hijacked conn deadlines = %v, want exactly one zero time", rec.conn.deadlines)
	}
}

func TestWriteDeadlineZeroIsPassthrough(t *testing.T) {
	// Zero disables the middleware, so every config.Config{} zero value in the
	// tests keeps the handler untouched.
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	got := WriteDeadline(0, discardLogger())(inner)
	if reflect.ValueOf(got).Pointer() != reflect.ValueOf(inner).Pointer() {
		t.Fatal("a zero timeout must return the handler unwrapped")
	}

	rec := &writeDeadlineRecorder{ResponseWriter: httptest.NewRecorder()}
	WriteDeadline(0, discardLogger())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("x"))
	})).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods", nil))
	if len(rec.deadlines) != 0 {
		t.Fatalf("a zero timeout must arm no deadline, got %d", len(rec.deadlines))
	}
}

// TestWriteDeadlineDropsAStalledReader is the regression for the finding: a
// client that never reads must not be able to park a handler (and with it an
// in-flight slot and an upstream connection) forever.
func TestWriteDeadlineDropsAStalledReader(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))

	errCh := make(chan error, 1)
	srv := httptest.NewServer(WriteDeadline(200*time.Millisecond, logger)(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			chunk := make([]byte, 64<<10)
			// Write until the socket buffers fill and the deadline fires, rather
			// than a fixed volume: how much a never-reading peer absorbs before
			// Write blocks is the host's buffer tuning, not something to guess.
			stop := time.Now().Add(4 * time.Second)
			for time.Now().Before(stop) {
				if _, err := w.Write(chunk); err != nil {
					errCh <- err
					return
				}
			}
			errCh <- nil
		})))
	defer srv.Close()

	conn, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	if _, err := io.WriteString(conn, "GET /k8s/api/v1/pods HTTP/1.1\r\nHost: x\r\n\r\n"); err != nil {
		t.Fatalf("write request: %v", err)
	}
	// Deliberately never read from conn.

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("handler kept writing for 4s without ever being stopped")
		}
		if !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("handler error = %v, want an i/o timeout", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("handler is still blocked writing to a client that never reads")
	}

	// The abort path is otherwise silent (ErrAbortHandler skips RequestLogger),
	// so the drop has to be stated here or it is invisible to an operator.
	if logged := logs.String(); !strings.Contains(logged, "client stopped reading") {
		t.Fatalf("a deadline drop must be logged, got: %q", logged)
	}
}

// TestWriteDeadlineKeepsAnIdleStreamIntact is the regression for the other half:
// the deadline must not still be expired when net/http writes the chunked
// terminator, or every watch and log follow that goes quiet ends in a truncated
// body instead of a clean EOF.
func TestWriteDeadlineKeepsAnIdleStreamIntact(t *testing.T) {
	const timeout = 200 * time.Millisecond
	srv := httptest.NewServer(WriteDeadline(timeout, discardLogger())(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("{\"type\":\"ADDED\"}\n"))
			_ = http.NewResponseController(w).Flush()
			// Quiet for far longer than the timeout, as an idle watch is, then
			// end the stream normally.
			time.Sleep(3 * timeout)
		})))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/k8s/api/v1/pods?watch=true")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("idle stream ended with %v instead of a clean EOF (body=%q)", err, body)
	}
	if string(body) != "{\"type\":\"ADDED\"}\n" {
		t.Fatalf("body = %q, want the single event written", body)
	}
}
