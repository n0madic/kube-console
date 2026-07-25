package exec

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	runtimeapi "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/rest"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
	"k8s.io/client-go/tools/remotecommand"
	utilexec "k8s.io/client-go/util/exec"
	"k8s.io/klog/v2"

	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/kube"
)

type fakeExecutor struct {
	stream func(ctx context.Context, opts remotecommand.StreamOptions) error
}

func (f *fakeExecutor) Stream(opts remotecommand.StreamOptions) error {
	return f.stream(context.Background(), opts)
}

func (f *fakeExecutor) StreamWithContext(ctx context.Context, opts remotecommand.StreamOptions) error {
	return f.stream(ctx, opts)
}

type testEnv struct {
	server  *httptest.Server
	handler *Handler
	logBuf  *bytes.Buffer
}

func newTestEnv(t *testing.T, maxSessions int, factory ExecutorFactory, opts ...func(*Handler)) *testEnv {
	t.Helper()
	base, _ := url.Parse("https://kubernetes.example")
	up := &kube.Upstream{
		BaseURL:    base,
		Transport:  http.DefaultTransport,
		RestConfig: &rest.Config{Host: "https://kubernetes.example"},
	}
	reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up})
	return newTestEnvForRegistry(t, reg, maxSessions, factory, opts...)
}

// opts tune the handler before the server starts (no data race with a live
// session), e.g. shortening drainTimeout.
func newTestEnvForRegistry(t *testing.T, reg *kube.Registry, maxSessions int, factory ExecutorFactory, opts ...func(*Handler)) *testEnv {
	t.Helper()
	logBuf := &bytes.Buffer{}
	cfg := &config.Config{
		ExecEnabled:     true,
		MaxExecSessions: maxSessions,
		ExecIdleTimeout: time.Minute,
	}
	h := NewHandler(reg, cfg, slog.New(slog.NewTextHandler(logBuf, nil)))
	h.authTimeout = 300 * time.Millisecond
	if factory != nil {
		h.executorFactory = factory
	}
	for _, opt := range opts {
		opt(h)
	}
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	return &testEnv{server: ts, handler: h, logBuf: logBuf}
}

func (e *testEnv) dial(t *testing.T, ctx context.Context) *websocket.Conn {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(e.server.URL, "http")
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	return conn
}

func readControlFrame(t *testing.T, ctx context.Context, conn *websocket.Conn) ControlFrame {
	t.Helper()
	typ, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read control frame: %v", err)
	}
	if typ != websocket.MessageText {
		t.Fatalf("expected text frame, got %v", typ)
	}
	var frame ControlFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		t.Fatalf("bad control frame %q: %v", data, err)
	}
	return frame
}

func sendAuth(t *testing.T, ctx context.Context, conn *websocket.Conn, frame AuthFrame) {
	t.Helper()
	data, _ := json.Marshal(frame)
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("send auth: %v", err)
	}
}

func TestNoAuthFrameClosesAfterTimeout(t *testing.T) {
	env := newTestEnv(t, 4, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Context cancellation during the pending read tears the connection down,
	// so the client observes a close instead of an error frame.
	start := time.Now()
	if _, _, err := conn.Read(ctx); err == nil {
		t.Fatal("connection should be closed after auth timeout")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("auth timeout took too long")
	}
}

func TestBinaryFirstFrameRejected(t *testing.T) {
	env := newTestEnv(t, 4, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")

	if err := conn.Write(ctx, websocket.MessageBinary, []byte("stdin-before-auth")); err != nil {
		t.Fatal(err)
	}
	frame := readControlFrame(t, ctx, conn)
	if frame.Type != "error" || !strings.Contains(frame.Message, "text auth frame") {
		t.Fatalf("unexpected frame: %+v", frame)
	}
}

func TestMalformedAuthJSONRejected(t *testing.T) {
	env := newTestEnv(t, 4, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")

	if err := conn.Write(ctx, websocket.MessageText, []byte("{not json")); err != nil {
		t.Fatal(err)
	}
	if frame := readControlFrame(t, ctx, conn); frame.Type != "error" {
		t.Fatalf("expected error frame, got %+v", frame)
	}
}

func TestNonAuthFirstFrameRejected(t *testing.T) {
	env := newTestEnv(t, 4, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")

	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":80,"rows":24}`)); err != nil {
		t.Fatal(err)
	}
	if frame := readControlFrame(t, ctx, conn); frame.Type != "error" {
		t.Fatalf("expected error frame, got %+v", frame)
	}
}

func TestInvalidTargetRejectedBeforeUpstream(t *testing.T) {
	factoryCalled := false
	env := newTestEnv(t, 4, func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
		factoryCalled = true
		return nil, errors.New("must not be called")
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")

	auth := validAuth()
	auth.Namespace = "Bad_NS"
	sendAuth(t, ctx, conn, auth)
	frame := readControlFrame(t, ctx, conn)
	if frame.Type != "error" || !strings.Contains(frame.Message, "invalid namespace") {
		t.Fatalf("unexpected frame: %+v", frame)
	}
	if factoryCalled {
		t.Fatal("executor factory must not run for invalid targets")
	}
}

func TestOversizedAuthFrameKillsConnection(t *testing.T) {
	factoryCalled := false
	env := newTestEnv(t, 4, func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
		factoryCalled = true
		return nil, errors.New("must not be called")
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")

	huge := `{"type":"auth","token":"` + strings.Repeat("t", maxAuthFrameBytes+1024) + `"}`
	_ = conn.Write(ctx, websocket.MessageText, []byte(huge))

	deadline := time.Now().Add(3 * time.Second)
	closed := false
	for time.Now().Before(deadline) {
		if _, _, err := conn.Read(ctx); err != nil {
			closed = true
			break
		}
	}
	if !closed {
		t.Fatal("connection must be closed after an oversized auth frame")
	}
	if factoryCalled {
		t.Fatal("executor factory must not run")
	}
}

func TestHappyPathEchoResizeExit(t *testing.T) {
	var gotToken string
	var gotURL string
	gotSize := make(chan remotecommand.TerminalSize, 1)

	env := newTestEnv(t, 4, func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
		gotToken = cfg.BearerToken
		gotURL = u.String()
		return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
			buf := make([]byte, 2)
			if _, err := io.ReadFull(opts.Stdin, buf); err != nil {
				return err
			}
			if _, err := opts.Stdout.Write(append([]byte("ok:"), buf...)); err != nil {
				return err
			}
			size := opts.TerminalSizeQueue.Next()
			if size == nil {
				return errors.New("no resize received")
			}
			gotSize <- *size
			return nil
		}}, nil
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")

	sendAuth(t, ctx, conn, AuthFrame{
		Type: "auth", Token: "SENTINEL-exec-token",
		Namespace: "default", Pod: "api-123", Container: "api",
	})

	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}

	if err := conn.Write(ctx, websocket.MessageBinary, []byte("hi")); err != nil {
		t.Fatal(err)
	}
	typ, data, err := conn.Read(ctx)
	if err != nil || typ != websocket.MessageBinary || string(data) != "ok:hi" {
		t.Fatalf("stdout echo = %v %q %v", typ, data, err)
	}

	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":120,"rows":40}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case size := <-gotSize:
		if size.Width != 120 || size.Height != 40 {
			t.Fatalf("size = %+v, want 120x40", size)
		}
	case <-ctx.Done():
		t.Fatal("executor never received the resize")
	}

	if frame := readControlFrame(t, ctx, conn); frame.Type != "exit" {
		t.Fatalf("expected exit frame, got %+v", frame)
	}

	if gotToken != "SENTINEL-exec-token" {
		t.Fatalf("executor config token = %q", gotToken)
	}
	for _, want := range []string{"/namespaces/default/pods/api-123/exec", "container=api", "command=%2Fbin%2Fsh", "stdin=true", "stdout=true", "tty=true"} {
		if !strings.Contains(gotURL, want) {
			t.Errorf("exec URL %q missing %q", gotURL, want)
		}
	}
	if strings.Contains(gotURL, "SENTINEL") {
		t.Fatal("token leaked into exec URL")
	}
	if strings.Contains(env.logBuf.String(), "SENTINEL") {
		t.Fatal("token leaked into logs")
	}
}

func TestExitCodePropagated(t *testing.T) {
	env := newTestEnv(t, 4, func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
		return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
			return utilexec.CodeExitError{Err: errors.New("command failed"), Code: 42}
		}}, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")

	sendAuth(t, ctx, conn, validAuth())
	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}
	frame := readControlFrame(t, ctx, conn)
	if frame.Type != "exit" || frame.Code == nil || *frame.Code != 42 {
		t.Fatalf("expected exit code 42, got %+v", frame)
	}
}

func TestRBACDenialAfterReady(t *testing.T) {
	env := newTestEnv(t, 4, func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
		return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
			return errors.New(`pods "api-123" is forbidden: user cannot create resource "pods/exec"`)
		}}, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")

	sendAuth(t, ctx, conn, validAuth())
	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}
	frame := readControlFrame(t, ctx, conn)
	if frame.Type != "error" || !strings.Contains(frame.Message, "forbidden") {
		t.Fatalf("expected RBAC error frame after ready, got %+v", frame)
	}
}

// The session limit applies once a connection has authenticated itself, so a
// client at the limit is turned away with an error frame after its auth frame
// — not at the handshake, which would let unauthenticated connections spend
// the slots (see TestHandshakeFloodDoesNotDenyAuthenticatedSessions).
func TestSessionLimitRejectsAfterAuth(t *testing.T) {
	blockExec := make(chan struct{})
	env := newTestEnv(t, 1, func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
		return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
			select {
			case <-blockExec:
			case <-ctx.Done():
			}
			return nil
		}}, nil
	})
	defer close(blockExec)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	first := env.dial(t, ctx)
	defer first.Close(websocket.StatusNormalClosure, "")
	sendAuth(t, ctx, first, validAuth())
	if frame := readControlFrame(t, ctx, first); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}

	second := env.dial(t, ctx)
	defer second.Close(websocket.StatusNormalClosure, "")
	sendAuth(t, ctx, second, validAuth())
	frame := readControlFrame(t, ctx, second)
	if frame.Type != "error" || !strings.Contains(frame.Message, "session limit reached") {
		t.Fatalf("unexpected frame: %+v", frame)
	}
}

// Regression: the session slot was taken before the WebSocket was even
// accepted, so anyone — no token, no Origin — could hold every slot open with
// bare handshakes and lock authenticated users out of exec entirely.
func TestHandshakeFloodDoesNotDenyAuthenticatedSessions(t *testing.T) {
	env := newTestEnv(t, 4,
		func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
			return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
				<-ctx.Done()
				return ctx.Err()
			}}, nil
		},
		// Long enough that the flooding connections are still pending when the
		// legitimate one authenticates.
		func(h *Handler) { h.authTimeout = 5 * time.Second },
	)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for i := 0; i < 5; i++ { // more than MaxExecSessions, all silent
		conn := env.dial(t, ctx)
		defer conn.CloseNow() //nolint:errcheck // test teardown
	}

	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")
	sendAuth(t, ctx, conn, validAuth())
	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready despite the handshake flood, got %+v", frame)
	}
}

// A promoted session hands its pending-pool slot back, so long-running
// terminals do not slowly starve the handshake pool.
func TestPromotionReleasesTheHandshakeSlot(t *testing.T) {
	env := newTestEnv(t, 2, func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
		return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
			<-ctx.Done()
			return ctx.Err()
		}}, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")
	sendAuth(t, ctx, conn, validAuth())
	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}
	if pending := len(env.handler.pending); pending != 0 {
		t.Fatalf("pending pool holds %d slots after promotion, want 0", pending)
	}
	if sessions := len(env.handler.sessions); sessions != 1 {
		t.Fatalf("session pool holds %d slots, want 1", sessions)
	}
}

// The pending pool is bounded too: a flood cannot pin unlimited goroutines and
// read buffers just by connecting.
func TestHandshakePoolIsBounded(t *testing.T) {
	env := newTestEnv(t, 1, nil, func(h *Handler) { h.authTimeout = 5 * time.Second })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for i := 0; i < handshakePoolFactor; i++ { // MaxExecSessions is 1 here
		conn := env.dial(t, ctx)
		defer conn.CloseNow() //nolint:errcheck // test teardown
	}
	wsURL := "ws" + strings.TrimPrefix(env.server.URL, "http")
	_, resp, err := websocket.Dial(ctx, wsURL, nil)
	if err == nil {
		t.Fatal("handshake past the pending pool must be rejected")
	}
	if resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected HTTP 503, got %+v", resp)
	}
}

// Per-IP handshake cap: one client cannot occupy the pending pool on its own.
func TestPerIPHandshakeLimit(t *testing.T) {
	env := newTestEnv(t, 8, nil, func(h *Handler) {
		h.authTimeout = 5 * time.Second
		h.handshakes = newIPGate(1)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	first := env.dial(t, ctx)
	defer first.CloseNow() //nolint:errcheck // test teardown

	wsURL := "ws" + strings.TrimPrefix(env.server.URL, "http")
	_, resp, err := websocket.Dial(ctx, wsURL, nil)
	if err == nil {
		t.Fatal("a second concurrent handshake from the same IP must be rejected")
	}
	if resp == nil || resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected HTTP 429, got %+v", resp)
	}
}

// The per-IP cap counts handshakes only: an established terminal must not
// count against the next one, or a team behind a shared proxy address would
// lock itself out.
func TestPerIPCapCountsHandshakesNotSessions(t *testing.T) {
	env := newTestEnv(t, 8,
		func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
			return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
				<-ctx.Done()
				return ctx.Err()
			}}, nil
		},
		func(h *Handler) { h.handshakes = newIPGate(1) },
	)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	for i := 0; i < 3; i++ {
		conn := env.dial(t, ctx)
		defer conn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // test teardown
		sendAuth(t, ctx, conn, validAuth())
		if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
			t.Fatalf("terminal %d: expected ready, got %+v", i, frame)
		}
	}
}

// TestReadLoopDoesNotLeakWhenStdinIsUnread reproduces the leak where a readLoop
// goroutine, blocked writing client stdin into the unbuffered pipe after the
// executor stopped reading it, never exits. Many such sessions are held open,
// then released at once; the reader-close on teardown must let every readLoop
// unblock so the goroutine count settles back near the baseline.
func TestReadLoopDoesNotLeakWhenStdinIsUnread(t *testing.T) {
	release := make(chan struct{})
	env := newTestEnv(t, 64, func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
		return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
			// Never read opts.Stdin: a client stdin frame stays stuck in the
			// unbuffered pipe write inside readLoop. Hold the session until released.
			<-release
			return nil
		}}, nil
	})

	runOne := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		conn := env.dial(t, ctx)
		sendAuth(t, ctx, conn, validAuth())
		if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
			t.Fatalf("expected ready, got %+v", frame)
		}
		// Stdin the executor will never read → readLoop blocks writing to the pipe.
		if err := conn.Write(ctx, websocket.MessageBinary, []byte("stuck")); err != nil {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond) // let readLoop reach the blocked write
		// Abrupt close (no handshake): the server readLoop is stuck in the pipe
		// write and cannot answer a close handshake, so Close() would block ~5s.
		_ = conn.CloseNow()
	}

	const iterations = 25
	runtime.GC()
	baseline := runtime.NumGoroutine()
	for i := 0; i < iterations; i++ {
		runOne()
	}
	close(release) // let every held session return and tear down

	// With the reader-close fix each stuck readLoop unblocks and exits; without
	// it, ~iterations readLoop goroutines leak permanently.
	deadline := time.Now().Add(5 * time.Second)
	final := 0
	for {
		runtime.GC()
		final = runtime.NumGoroutine()
		if final <= baseline+5 || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if final > baseline+5 {
		t.Fatalf("goroutine leak: %d goroutines vs baseline %d after %d unread-stdin sessions", final, baseline, iterations)
	}
}

// A browser that goes away (terminal closed, tab or window gone) must end the
// session through stdin EOF — the shell exits on its own and the upstream
// stream closes cleanly — not by cancelling the session context, which tears
// the upstream connection down mid-copy.
func TestClientDisconnectEndsSessionOnStdinEOF(t *testing.T) {
	ended := make(chan error, 1) // ctx.Err() as observed when the stream ends
	env := newTestEnv(t, 4, func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
		return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
			_, _ = io.Copy(io.Discard, opts.Stdin) // returns when readLoop closes stdin
			ended <- ctx.Err()
			return nil
		}}, nil
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	sendAuth(t, ctx, conn, validAuth())
	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}
	conn.Close(websocket.StatusNormalClosure, "")

	select {
	case err := <-ended:
		if err != nil {
			t.Fatalf("session was cancelled instead of ending on stdin EOF: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("session did not end after the client disconnected")
	}
}

// Fallback for a command that ignores stdin EOF: the session must not linger
// (holding one of the exec slots) until the idle timeout.
func TestClientDisconnectCancelsCommandIgnoringStdinEOF(t *testing.T) {
	ended := make(chan struct{})
	env := newTestEnv(t, 4,
		func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
			return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
				<-ctx.Done() // never reads stdin: only cancellation can end this
				close(ended)
				return ctx.Err()
			}}, nil
		},
		func(h *Handler) { h.drainTimeout = 100 * time.Millisecond },
	)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	sendAuth(t, ctx, conn, validAuth())
	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}
	conn.Close(websocket.StatusNormalClosure, "")

	select {
	case <-ended:
	case <-time.After(3 * time.Second):
		t.Fatal("session outlived the client instead of being cancelled after the grace period")
	}
}

// The client's departure must be noticed even while its command is not reading
// stdin: the pending write parks stdinPump, not readLoop, so conn.Read still
// observes the close and the drain path starts on time. Before the split the
// session sat in the pipe write until the idle timeout (or until the 30s ping,
// which needs a concurrent reader to see its pong, timed the session out).
func TestClientDisconnectDetectedWhileStdinIsUnread(t *testing.T) {
	ended := make(chan struct{})
	env := newTestEnv(t, 4,
		func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
			return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
				<-ctx.Done() // never reads opts.Stdin
				close(ended)
				return ctx.Err()
			}}, nil
		},
		func(h *Handler) { h.drainTimeout = 100 * time.Millisecond },
	)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	sendAuth(t, ctx, conn, validAuth())
	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}
	if err := conn.Write(ctx, websocket.MessageBinary, []byte("stuck")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond) // let stdinPump reach the blocked write
	_ = conn.CloseNow()

	select {
	case <-ended:
	case <-time.After(3 * time.Second):
		t.Fatal("disconnect went unnoticed while stdin was unread: the session outlived its client")
	}
}

// Once the client is gone, client-go narrates its own teardown through the
// session's contextual logger ("Copying stdout failed" / "Websocket Ping
// failed", all "use of closed network connection" from the connection it closes
// itself). None of it may reach the log — not even with debug logging on, where
// it would otherwise appear on every closed terminal.
func TestTeardownNarrationIsNotLogged(t *testing.T) {
	logged := make(chan struct{})
	// Debug level: what the operator saw the noise at.
	buf := &bytes.Buffer{}
	env := newTestEnv(t, 4,
		func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
			return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
				logger := klog.FromContext(ctx)
				logger.Info("stream started") // before the client leaves: kept
				<-ctx.Done()
				logger.Error(errors.New("use of closed network connection"), "Copying stdout failed")
				close(logged)
				return ctx.Err()
			}}, nil
		},
		func(h *Handler) {
			h.drainTimeout = 100 * time.Millisecond
			h.logger = slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
		},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	sendAuth(t, ctx, conn, validAuth())
	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}
	conn.Close(websocket.StatusNormalClosure, "")

	select {
	case <-logged:
	case <-time.After(3 * time.Second):
		t.Fatal("executor never reached its teardown log")
	}

	out := buf.String()
	if !strings.Contains(out, "stream started") {
		t.Fatalf("client-go logging before teardown must survive, got %q", out)
	}
	if strings.Contains(out, "Copying stdout failed") {
		t.Fatalf("teardown narration reached the log: %q", out)
	}
}

func TestExecDisabled404(t *testing.T) {
	base, _ := url.Parse("https://kubernetes.example")
	up := &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport, RestConfig: &rest.Config{Host: "https://kubernetes.example"}}
	reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up})
	cfg := &config.Config{ExecEnabled: false, MaxExecSessions: 1, ExecIdleTimeout: time.Minute}
	h := NewHandler(reg, cfg, slog.New(slog.DiscardHandler))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ui/exec/ws", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 when exec is disabled", rec.Code)
	}
}

// newTwoContextRegistry wires alpha (default) + beta with distinct RestConfig
// hosts so the resolved context can be asserted from the executor's config.
func newTwoContextRegistry() *kube.Registry {
	alphaBase, _ := url.Parse("https://alpha.example")
	betaBase, _ := url.Parse("https://beta.example")
	return kube.NewRegistryFromUpstreams("alpha", map[string]*kube.Upstream{
		"alpha": {BaseURL: alphaBase, Transport: http.DefaultTransport, RestConfig: &rest.Config{Host: "https://alpha.example"}},
		"beta":  {BaseURL: betaBase, Transport: http.DefaultTransport, RestConfig: &rest.Config{Host: "https://beta.example"}},
	})
}

// The auth frame's context selects which cluster's RestConfig the executor gets.
func TestExecContextSelectsUpstream(t *testing.T) {
	gotHost := make(chan string, 1)
	env := newTestEnvForRegistry(t, newTwoContextRegistry(), 4, func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
		gotHost <- cfg.Host
		return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
			return nil
		}}, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")

	auth := validAuth()
	auth.Context = "beta"
	sendAuth(t, ctx, conn, auth)
	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}
	select {
	case host := <-gotHost:
		if host != "https://beta.example" {
			t.Fatalf("executor config host = %q, want beta", host)
		}
	case <-ctx.Done():
		t.Fatal("executor factory never ran")
	}
}

func TestExecUnknownContextErrorFrame(t *testing.T) {
	factoryCalled := false
	env := newTestEnvForRegistry(t, newTwoContextRegistry(), 4, func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
		factoryCalled = true
		return nil, errors.New("must not be called")
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")

	auth := validAuth()
	auth.Context = "ghost"
	sendAuth(t, ctx, conn, auth)
	frame := readControlFrame(t, ctx, conn)
	if frame.Type != "error" || !strings.Contains(frame.Message, "unknown cluster context") {
		t.Fatalf("unexpected frame: %+v", frame)
	}
	if factoryCalled {
		t.Fatal("executor factory must not run for an unknown context")
	}
}

// Regression: buildExecURL returned req.URL() without checking the builder's
// accumulated error, silently emitting a malformed path (e.g.
// /namespaces//pods//exec) for segments client-go rejects. AuthFrame
// validation is stricter today, so this guards the defense-in-depth layer.
func TestBuildExecURLRejectsInvalidPathSegments(t *testing.T) {
	cfg := &rest.Config{Host: "https://kube.invalid"}
	for _, bad := range []AuthFrame{
		{Namespace: "default", Pod: "../etc", Container: "app", Command: []string{"/bin/sh"}},
		{Namespace: "a/b", Pod: "web-1", Container: "app", Command: []string{"/bin/sh"}},
	} {
		u, err := buildExecURL(cfg, &bad)
		if err == nil {
			t.Errorf("buildExecURL(%+v) = %v, want error", bad, u)
		}
	}
}

func TestBuildExecURLHappyPath(t *testing.T) {
	cfg := &rest.Config{Host: "https://kube.invalid"}
	u, err := buildExecURL(cfg, &AuthFrame{
		Namespace: "default", Pod: "web-1", Container: "app", Command: []string{"/bin/sh"},
	})
	if err != nil {
		t.Fatalf("buildExecURL: %v", err)
	}
	if !strings.Contains(u.Path, "/namespaces/default/pods/web-1/exec") {
		t.Errorf("unexpected exec path %q", u.Path)
	}
}

// In --use-kubeconfig-credentials mode the browser sends an auth frame with no
// token, and the per-connection config must keep the context's own credentials
// instead of being blanked by the empty one. Outside that mode the same frame
// is still rejected.
func TestExecEmptyTokenWithConfigCredentials(t *testing.T) {
	newEnv := func(t *testing.T, useConfigCreds bool, gotToken chan<- string) *testEnv {
		t.Helper()
		base, _ := url.Parse("https://kubernetes.example")
		up := &kube.Upstream{
			BaseURL:              base,
			Transport:            http.DefaultTransport,
			RestConfig:           &rest.Config{Host: "https://kubernetes.example", BearerToken: "kubeconfig-token"},
			UseConfigCredentials: useConfigCreds,
		}
		reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up})
		return newTestEnvForRegistry(t, reg, 4, func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
			gotToken <- cfg.BearerToken
			return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
				return nil
			}}, nil
		})
	}

	t.Run("accepted in config-credentials mode", func(t *testing.T) {
		gotToken := make(chan string, 1)
		env := newEnv(t, true, gotToken)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		conn := env.dial(t, ctx)
		defer conn.Close(websocket.StatusNormalClosure, "")

		auth := validAuth()
		auth.Token = ""
		sendAuth(t, ctx, conn, auth)
		if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
			t.Fatalf("expected ready for a tokenless frame in this mode, got %+v", frame)
		}
		select {
		case token := <-gotToken:
			if token != "kubeconfig-token" {
				t.Fatalf("executor config BearerToken = %q, want the kubeconfig's own", token)
			}
		case <-ctx.Done():
			t.Fatal("executor factory never ran")
		}
	})

	t.Run("rejected otherwise", func(t *testing.T) {
		gotToken := make(chan string, 1)
		env := newEnv(t, false, gotToken)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		conn := env.dial(t, ctx)
		defer conn.Close(websocket.StatusNormalClosure, "")

		auth := validAuth()
		auth.Token = ""
		sendAuth(t, ctx, conn, auth)
		if frame := readControlFrame(t, ctx, conn); frame.Type != "error" {
			t.Fatalf("expected an error frame for a tokenless frame, got %+v", frame)
		}
		select {
		case token := <-gotToken:
			t.Fatalf("executor factory ran with token %q", token)
		default:
		}
	})
}

// Regression: the idle timeout only cancelled the session context, which makes
// coder/websocket close the socket from under readLoop — so the error frame the
// teardown would have produced ("context canceled", itself meaningless in a
// terminal) never reached the browser at all and the terminal just went dead.
// The reason has to be written before the cancellation, not after it.
func TestIdleTimeoutReportsWhyTheSessionEnded(t *testing.T) {
	env := newTestEnv(t, 4,
		func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
			return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
				<-ctx.Done() // an interactive shell: only cancellation ends it
				return ctx.Err()
			}}, nil
		},
		func(h *Handler) { h.idleTimeout = 50 * time.Millisecond },
	)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")
	sendAuth(t, ctx, conn, validAuth())
	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}

	frame := readControlFrame(t, ctx, conn)
	if frame.Type != "error" {
		t.Fatalf("expected an error frame after the idle timeout, got %+v", frame)
	}
	if strings.Contains(frame.Message, "context canceled") {
		t.Errorf("error frame leaks the raw Go error: %q", frame.Message)
	}
	if !strings.Contains(frame.Message, "idle timeout") {
		t.Errorf("error frame does not name the cause: %q", frame.Message)
	}
}

// The counterpart: a real stream failure must still reach the browser as-is.
func TestStreamFailureMessageIsForwardedVerbatim(t *testing.T) {
	env := newTestEnv(t, 4,
		func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
			return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
				return errors.New("pods \"web\" is forbidden: exec denied")
			}}, nil
		},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	defer conn.Close(websocket.StatusNormalClosure, "")
	sendAuth(t, ctx, conn, validAuth())
	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}
	frame := readControlFrame(t, ctx, conn)
	if frame.Type != "error" || !strings.Contains(frame.Message, "exec denied") {
		t.Fatalf("upstream failure was not forwarded: %+v", frame)
	}
}

// Regression: the idle timeout's error frame used to be written inline, so the
// callback took writeMu before it could call end(). A stdout write holds that
// lock for its whole duration and coder/websocket's Write blocks until the
// client accepts the bytes or the session context is cancelled — so a client
// that stopped reading pinned the lock, the callback parked on it, and the idle
// timeout could never fire for exactly the session it exists to reclaim (its
// slot included). Ending the session is what unblocks that writer, so it must
// not be queued behind it.
func TestIdleTimeoutEndsTheSessionEvenWhileTheWriteLockIsHeld(t *testing.T) {
	h := &Handler{idleTimeout: time.Minute, idleFrameTimeout: 20 * time.Millisecond}

	var writeMu sync.Mutex
	// Deliberately never unlocked: it stands in for a stdout write stalled on a
	// client that stopped reading, which only the cancellation below releases.
	// The frame goroutine stays parked on it for the rest of the test, which is
	// the point — end() must happen without it.
	writeMu.Lock()

	ended := make(chan struct{})
	go h.reportAndEnd(context.Background(), nil, &writeMu, func() { close(ended) }, "idle timeout")

	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("the idle timeout never ended the session: it parked on the write lock")
	}
}

// Regression: the callback's guard was `sessionCtx.Err() != nil`, which cannot
// see a session ending normally — cancel() is deferred before idle.Stop() and
// therefore runs after it, so from awaitStream returning through the exit frame
// the context is still live. A deadline landing in that window wrote a spurious
// "idle timeout" frame behind the exit frame. The guard is now the teardown
// claim the ordinary path takes first.
func TestIdleTimeoutIsSilentOnceTheTeardownIsClaimed(t *testing.T) {
	h := &Handler{idleTimeout: time.Minute, idleFrameTimeout: 20 * time.Millisecond}

	var writeMu sync.Mutex
	// Held, as above, so a regressed guard parks its frame goroutine on the lock
	// instead of writing to the nil conn — it then still reaches end() after
	// idleFrameTimeout, which is what this asserts against.
	writeMu.Lock()

	var ending atomic.Bool
	ending.Store(true) // the normal teardown got there first

	ended := make(chan struct{})
	h.idleFired(context.Background(), nil, &writeMu, &ending, func() { close(ended) })

	select {
	case <-ended:
		t.Fatal("the idle deadline ended a session whose teardown was already claimed")
	default:
	}
}

// Regression: readLoop used to hand stdin over on a bounded channel with a
// blocking send, so once the queue filled it parked OUTSIDE conn.Read.
// coder/websocket only matches a pong from inside a Reader call, so the ping
// timed out and cancelled a session whose client was present and answering —
// measured at 40s (one 30s tick plus the 10s pong deadline) with a live client.
// The predecessor test sent a single frame, which parks stdinPump and leaves
// readLoop in conn.Read, so it never covered the full-queue case.
func TestSessionSurvivesStdinBackpressureBeyondQueueDepth(t *testing.T) {
	streaming := make(chan struct{})
	env := newTestEnv(t, 4,
		func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
			return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
				close(streaming)
				<-ctx.Done() // never reads opts.Stdin: the pty equivalent of a stalled process
				return ctx.Err()
			}}, nil
		},
		func(h *Handler) {
			// A real terminal would take 40s to reach the verdict; drive the
			// keepalive fast enough to cross several cycles inside the test.
			h.pingInterval = 40 * time.Millisecond
			h.pingTimeout = 20 * time.Millisecond
			h.drainTimeout = 100 * time.Millisecond
		},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	sendAuth(t, ctx, conn, validAuth())
	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}
	<-streaming

	// A real browser is always reading, which is also how coder/websocket
	// answers the server's pings — the pong is sent from inside a Read call, so
	// a client that stops reading would fail the keepalive for reasons of its
	// own and prove nothing about the server.
	serverFrames := make(chan string, 4)
	go func() {
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				serverFrames <- "closed: " + err.Error()
				return
			}
			serverFrames <- string(data)
		}
	}()

	// Far more frames than any internal queue depth, none of which the command
	// will ever read.
	for i := 0; i < 64; i++ {
		if err := conn.Write(ctx, websocket.MessageBinary, []byte("unread input")); err != nil {
			t.Fatalf("write %d failed while the command was not reading stdin: %v", i, err)
		}
	}

	// Outlast several ping cycles: with the reader parked outside conn.Read the
	// first missed pong ends the session.
	select {
	case frame := <-serverFrames:
		t.Fatalf("session was torn down during stdin backpressure: %s", frame)
	case <-time.After(300 * time.Millisecond):
	}

	// Still usable: the connection accepts further input after the stall.
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":100,"rows":40}`)); err != nil {
		t.Fatalf("session was torn down during stdin backpressure: %v", err)
	}
}

// The byte cap on staged stdin is an explicit decision, not backpressure onto
// the socket reader: the session ends with the reason stated rather than
// dropping input, which would corrupt the stream the command eventually reads.
func TestStdinOverflowEndsSessionWithStatedReason(t *testing.T) {
	env := newTestEnv(t, 4,
		func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
			return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
				<-ctx.Done() // never reads opts.Stdin
				return ctx.Err()
			}}, nil
		},
		func(h *Handler) {
			h.stdinBufferLimit = 256
			h.drainTimeout = 100 * time.Millisecond
		},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	sendAuth(t, ctx, conn, validAuth())
	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}
	for i := 0; i < 32; i++ {
		if err := conn.Write(ctx, websocket.MessageBinary, bytes.Repeat([]byte("x"), 64)); err != nil {
			break // the server may already have closed after stating the reason
		}
	}

	frame := readControlFrame(t, ctx, conn)
	if frame.Type != "error" || !strings.Contains(frame.Message, "unread input") {
		t.Fatalf("expected the overflow reason, got %+v", frame)
	}
}

// rest.CopyConfig aliases ExecProvider and then writes through it, so copying
// the shared config for a connection used to mutate the registry's own
// Upstream.RestConfig — read concurrently by the readiness probe and every
// adapter, and documented as never mutated after construction.
func TestPerConnectionConfigDoesNotMutateSharedRestConfig(t *testing.T) {
	base, _ := url.Parse("https://kubernetes.example")
	provider := &clientcmdapi.ExecConfig{
		Command:    "aws",
		Args:       []string{"eks", "get-token"},
		APIVersion: "client.authentication.k8s.io/v1beta1",
		// Populated from the cluster's client.authentication.k8s.io/exec
		// extension, and the only reason CopyConfig writes to its source.
		Config: &runtimeapi.Unknown{Raw: []byte(`{"cluster":"a"}`)},
	}
	shared := &rest.Config{Host: "https://kubernetes.example", ExecProvider: provider}
	up := &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport, RestConfig: shared}
	reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up})

	streaming := make(chan struct{})
	env := newTestEnvForRegistry(t, reg, 4,
		func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
			return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
				close(streaming)
				<-ctx.Done()
				return ctx.Err()
			}}, nil
		},
		func(h *Handler) { h.drainTimeout = 100 * time.Millisecond },
	)

	before := provider.Config
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := env.dial(t, ctx)
	sendAuth(t, ctx, conn, validAuth())
	if frame := readControlFrame(t, ctx, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}
	<-streaming

	if provider.Config != before {
		t.Fatal("building the per-connection config rewrote the shared Upstream.RestConfig's ExecProvider")
	}
	if up.RestConfig != shared || up.RestConfig.ExecProvider != provider {
		t.Fatal("the shared config was replaced instead of copied")
	}
}

// coder/websocket builds its Accept errors out of inbound header values, and
// this endpoint is pre-auth and unmetered by default, so the error text must
// never reach the log: "logs never contain headers, bodies or query strings".
func TestAcceptFailureDoesNotLogHeaderValues(t *testing.T) {
	buf := &bytes.Buffer{}
	env := newTestEnv(t, 4,
		func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
			return &fakeExecutor{stream: func(ctx context.Context, opts remotecommand.StreamOptions) error {
				return nil
			}}, nil
		},
		func(h *Handler) {
			h.logger = slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
		},
	)

	req, err := http.NewRequest(http.MethodGet, env.server.URL+"/api/ui/exec/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	// A handshake Accept rejects, carrying sentinels in the values it echoes.
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "SENTINEL-WS-KEY")
	req.Header.Set("Origin", "http://sentinel-origin.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode == http.StatusSwitchingProtocols {
		t.Fatal("expected the handshake to be rejected")
	}

	logged := buf.String()
	if !strings.Contains(logged, "accept failed") {
		t.Fatalf("the rejected handshake was not logged at all: %q", logged)
	}
	for _, sentinel := range []string{"SENTINEL-WS-KEY", "sentinel-origin.example"} {
		if strings.Contains(logged, sentinel) {
			t.Fatalf("client-supplied header value %q reached the log: %q", sentinel, logged)
		}
	}
}
