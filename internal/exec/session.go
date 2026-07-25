package exec

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
	utilexec "k8s.io/client-go/util/exec"
	"k8s.io/klog/v2"
	"k8s.io/streaming/pkg/httpstream"

	"github.com/n0madic/kube-console/internal/kube"
)

// ExecutorFactory builds a remotecommand.Executor for the exec URL; replaced
// by a fake in tests.
type ExecutorFactory func(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error)

// defaultExecutorFactory prefers the WebSocket executor and falls back to
// SPDY when the upstream cannot upgrade.
func defaultExecutorFactory(cfg *rest.Config, method string, u *url.URL) (remotecommand.Executor, error) {
	wsExec, err := remotecommand.NewWebSocketExecutor(cfg, method, u.String())
	if err != nil {
		return nil, err
	}
	spdyExec, err := remotecommand.NewSPDYExecutor(cfg, method, u)
	if err != nil {
		return nil, err
	}
	return remotecommand.NewFallbackExecutor(wsExec, spdyExec, shouldFallbackToSPDY)
}

// shouldFallbackToSPDY decides whether a WebSocket exec attempt failed in a way
// that warrants retrying over SPDY. It must test the error types client-go's
// own remotecommand package produces, which live in k8s.io/streaming — the
// identically named types in k8s.io/apimachinery/pkg/util/httpstream are a
// distinct package, so matching against those silently never fires and the
// fallback becomes dead code against any apiserver that cannot upgrade.
func shouldFallbackToSPDY(err error) bool {
	return httpstream.IsUpgradeFailure(err) || httpstream.IsHTTPSProxyError(err)
}

// session drives one exec connection: read auth frame, take a session slot,
// build a transient per-connection client config, stream, report exit/error.
// releaseHandshake hands the connection's pending-pool slot back; it is called
// the moment a session slot is taken instead (and, idempotently, by the caller
// on every other exit path).
func (h *Handler) session(ctx context.Context, conn *websocket.Conn, releaseHandshake func()) {
	var writeMu sync.Mutex

	// Bound the first frame before reading anything.
	conn.SetReadLimit(maxAuthFrameBytes)

	authCtx, cancelAuth := context.WithTimeout(ctx, h.authTimeout)
	auth, err := readAuthFrame(authCtx, conn, !h.registry.UsesConfigCredentials())
	cancelAuth()
	if err != nil {
		_ = writeControl(ctx, conn, &writeMu, ControlFrame{Type: "error", Message: err.Error()})
		conn.Close(websocket.StatusPolicyViolation, "authentication failed")
		return
	}

	// Resolve the requested cluster before touching any config. An unknown
	// context fails closed with an error frame; the executor factory never runs.
	up, _, err := h.registry.Resolve(auth.Context)
	if err != nil {
		_ = writeControl(ctx, conn, &writeMu, ControlFrame{Type: "error", Message: kube.UnknownContextMessage})
		conn.Close(websocket.StatusPolicyViolation, "unknown context")
		return
	}

	// The connection has named a cluster, a pod and a token, so it graduates
	// from the pending pool into a real session slot. Doing it here rather
	// than at accept time is what makes the session limit a limit on *use* of
	// exec instead of on merely connecting to the endpoint.
	select {
	case h.sessions <- struct{}{}:
		releaseHandshake()
		defer func() { <-h.sessions }()
	default:
		_ = writeControl(ctx, conn, &writeMu, ControlFrame{Type: "error", Message: "exec session limit reached"})
		conn.Close(websocket.StatusTryAgainLater, "session limit reached")
		return
	}

	// Transient per-connection config: a copy of the shared credential-free
	// config plus the user token. Never stored, never logged. In
	// use-kubeconfig-credentials mode the copy already carries the context's own
	// credentials and the frame's token is empty, so leave it alone — assigning
	// would blank out whatever the kubeconfig authenticates with.
	// rest.CopyConfig shares the ExecProvider pointer and then writes through it
	// (c.ExecProvider.Config = ...DeepCopyObject()), so copying the shared config
	// would mutate it — and up.RestConfig is read concurrently by the readiness
	// probe and every adapter. Detach the provider first: one exec-plugin
	// kubeconfig plus two concurrent handshakes is otherwise a data race on
	// state documented as never mutated after construction.
	shared := up.RestConfig
	if shared.ExecProvider != nil {
		detached := *shared
		detached.ExecProvider = shared.ExecProvider.DeepCopy()
		shared = &detached
	}
	cfg := rest.CopyConfig(shared)
	if !up.UseConfigCredentials {
		cfg.BearerToken = auth.Token
	}

	execURL, err := buildExecURL(cfg, auth)
	if err != nil {
		_ = writeControl(ctx, conn, &writeMu, ControlFrame{Type: "error", Message: "failed to build exec request"})
		conn.Close(websocket.StatusInternalError, "exec setup failed")
		return
	}
	executor, err := h.executorFactory(cfg, "POST", execURL)
	if err != nil {
		_ = writeControl(ctx, conn, &writeMu, ControlFrame{Type: "error", Message: "failed to build exec client"})
		conn.Close(websocket.StatusInternalError, "exec setup failed")
		return
	}

	sessionCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// client-go reports its own stream teardown through klog at error level
	// ("Copying stdout failed", "Waiting for server to close stdin failed",
	// "Websocket Ping failed" — all "use of closed network connection" once the
	// upstream connection is closed), which lands on stderr outside our logger
	// on every ended session. Bind ours to the session context so contextual
	// logging routes it into the app log at debug level instead, and goes quiet
	// altogether once the session is over. A genuine stream failure still comes
	// back as streamErr and reaches the browser as an error frame.
	var quiet atomic.Bool
	sessionCtx = klog.NewContext(sessionCtx, debugLogr(h.logger, &quiet))
	// ending is claimed by whichever teardown path gets there first, and exists
	// for the idle callback below: Stop() cannot recall a callback that has
	// already started, and sessionCtx is no substitute for this — cancel() is
	// deferred *before* idle.Stop() and therefore runs *after* it, so the entire
	// normal teardown window (awaitStream returning, the exit frame, conn.Close)
	// would pass an `Err() != nil` check with the error still nil.
	var ending atomic.Bool
	// end ends the session: claim the teardown, silence the narration, cancel.
	end := func() {
		ending.Store(true)
		quiet.Store(true)
		cancel()
	}

	// Idle timeout: no traffic in either direction ends the session.
	//
	// The reason is sent *before* ending it, and that ordering is the whole
	// point: cancelling the session context makes coder/websocket close the
	// socket from under readLoop, so nothing written afterwards — including the
	// error frame the switch below would build from client-go's "context
	// canceled" — ever reaches the browser. The terminal would simply go dead
	// with no explanation of why or whether reconnecting helps.
	idle := time.AfterFunc(h.idleTimeout, func() {
		h.idleFired(ctx, conn, &writeMu, &ending, end)
	})
	defer idle.Stop()
	activity := func() { idle.Reset(h.idleTimeout) }

	// Larger frames are fine after auth (stdin paste bursts).
	conn.SetReadLimit(maxSessionFrameBytes)

	stdinReader, stdinWriter := io.Pipe()
	// Close the read half on teardown so a readLoop goroutine blocked writing
	// stdin into an unbuffered pipe the executor has stopped reading (process
	// exited mid-paste) unblocks with ErrClosedPipe instead of leaking. cancel()
	// alone cannot interrupt a blocked pipe write.
	defer stdinReader.Close()
	sizes := newSizeQueue()
	// Staging stdin is bounded by bytes, not by blocking: a frame that would
	// overrun the cap ends the session with the reason stated, because dropping
	// it silently would corrupt the byte stream the command eventually reads.
	// The cap is only reachable when the process in the container has stopped
	// reading its input.
	overflow := func() {
		if !ending.CompareAndSwap(false, true) {
			return
		}
		h.reportAndEnd(ctx, conn, &writeMu, end,
			"exec session closed: too much unread input buffered — the process in the container is not reading stdin")
	}
	clientGone := make(chan struct{})
	go func() {
		readLoop(sessionCtx, conn, stdinWriter, sizes, activity, h.stdinBufferLimit, overflow)
		close(clientGone)
	}()
	go h.pingLoop(sessionCtx, conn, clientGone, end)

	if err := writeControl(sessionCtx, conn, &writeMu, ControlFrame{Type: "ready"}); err != nil {
		conn.Close(websocket.StatusInternalError, "failed to send ready")
		return
	}

	// Note: an RBAC denial surfaces here, after "ready" — the UI renders the
	// error frame in the terminal as a normal outcome.
	streamDone := make(chan error, 1)
	go func() {
		streamDone <- executor.StreamWithContext(sessionCtx, remotecommand.StreamOptions{
			Stdin:             stdinReader,
			Stdout:            &wsWriter{ctx: sessionCtx, conn: conn, mu: &writeMu, activity: activity},
			Tty:               true,
			TerminalSizeQueue: sizes,
		})
	}()
	streamErr := h.awaitStream(streamDone, clientGone, &quiet, cancel)
	// The stream is over, so claim the teardown before reporting its outcome: an
	// idle deadline landing in the next few microseconds would otherwise chase
	// the exit frame with an "idle timeout" error frame. The deferred idle.Stop()
	// cannot do this on its own — see `ending`.
	ending.Store(true)

	switch {
	case streamErr == nil:
		_ = writeControl(ctx, conn, &writeMu, ControlFrame{Type: "exit"})
	default:
		var exitErr utilexec.CodeExitError
		if errors.As(streamErr, &exitErr) {
			code := exitErr.Code
			_ = writeControl(ctx, conn, &writeMu, ControlFrame{Type: "exit", Code: &code})
		} else {
			_ = writeControl(ctx, conn, &writeMu, ControlFrame{Type: "error", Message: streamErr.Error()})
		}
	}
	conn.Close(websocket.StatusNormalClosure, "session ended")
}

// idleFired runs the idle deadline: claim the session's teardown, and only if
// the claim succeeds tell the browser why its terminal is closing.
//
// The claim is the guard, because time.Timer.Stop() cannot recall a callback
// that has already started and the session context cannot stand in for one:
// cancel() is deferred before idle.Stop() and so runs after it, leaving the
// whole normal teardown unguarded — the client would get a spurious "idle
// timeout" frame right behind its exit frame.
func (h *Handler) idleFired(ctx context.Context, conn *websocket.Conn, mu *sync.Mutex, ending *atomic.Bool, end func()) {
	if !ending.CompareAndSwap(false, true) {
		return
	}
	h.reportAndEnd(ctx, conn, mu, end,
		"exec session closed: idle timeout after "+h.idleTimeout.String())
}

// reportAndEnd tells the browser why its terminal is about to close, then ends
// the session — in that order, and with the second step not conditional on the
// first. Callers must have claimed the teardown first.
//
// The ordering is the point of the frame at all: cancelling makes
// coder/websocket close the socket from under readLoop, so nothing written
// afterwards reaches the browser and the terminal would just go dead. But the
// write must not gate `end`. writeMu is held for the whole of a stdout write,
// and coder/websocket's Write blocks until the socket accepts the bytes or the
// session context is done — so a client that stopped reading pins the lock, and
// waiting for it here would mean the deadline can never fire for exactly the
// session it exists to reclaim (cancelling is what unblocks that writer, and
// the session slot is held until it does).
//
// Hence the frame goes out beside this call, bounded by idleFrameTimeout, and
// the session ends either way. The goroutine is not leaked: end() cancels the
// session, the stalled writer it is queued behind returns, and the write then
// fails on the closed connection.
func (h *Handler) reportAndEnd(ctx context.Context, conn *websocket.Conn, mu *sync.Mutex, end func(), message string) {
	sent := make(chan struct{})
	go func() {
		defer close(sent)
		_ = writeControl(ctx, conn, mu, ControlFrame{Type: "error", Message: message})
	}()
	timer := time.NewTimer(h.idleFrameTimeout)
	defer timer.Stop()
	select {
	case <-sent:
	case <-timer.C:
	}
	end()
}

// awaitStream waits for the exec stream to end. When the browser leaves first
// (terminal closed, tab or window gone, network drop), stdin is closed behind
// it, so a command that ends on EOF gets a short grace period to finish and
// close the upstream stream itself. An interactive shell on a TTY usually does
// not — the kubelet keeps the pty open — so the grace period is kept short:
// cancelling is then the normal outcome, and it is also how kubectl ends a
// session whose client went away (the connection drops and the kubelet reaps
// the process). What cancelling must not do is take the session's slot with it,
// which is why it happens here and not at the idle timeout.
func (h *Handler) awaitStream(streamDone <-chan error, clientGone <-chan struct{}, quiet *atomic.Bool, cancel context.CancelFunc) error {
	select {
	case err := <-streamDone:
		return err
	case <-clientGone:
	}
	// Nobody is left to receive an error frame, so from here on client-go is
	// only narrating the teardown of a session that is already over.
	quiet.Store(true)
	timer := time.NewTimer(h.drainTimeout)
	defer timer.Stop()
	select {
	case err := <-streamDone:
		return err
	case <-timer.C:
		cancel()
		return <-streamDone
	}
}

// readAuthFrame reads and validates the mandatory first text frame.
// requireToken is threaded into validate: see AuthFrame.validate.
func readAuthFrame(ctx context.Context, conn *websocket.Conn, requireToken bool) (*AuthFrame, error) {
	typ, data, err := conn.Read(ctx)
	if err != nil {
		return nil, errors.New("no auth frame received")
	}
	if typ != websocket.MessageText {
		return nil, errors.New("first frame must be a text auth frame")
	}
	var frame AuthFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return nil, errors.New("auth frame is not valid JSON")
	}
	if err := frame.validate(requireToken); err != nil {
		return nil, err
	}
	return &frame, nil
}

// buildExecURL constructs the pods/exec URL with the standard client-go
// parameter encoding (stdin/stdout/tty, container, command array).
func buildExecURL(cfg *rest.Config, auth *AuthFrame) (*url.URL, error) {
	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	req := clientset.CoreV1().RESTClient().Post().
		Resource("pods").
		Namespace(auth.Namespace).
		Name(auth.Pod).
		SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: auth.Container,
			Command:   auth.Command,
			Stdin:     true,
			Stdout:    true,
			TTY:       true,
		}, scheme.ParameterCodec)
	// The builder records invalid path segments (Namespace/Name) internally
	// and would silently emit a malformed URL; fail closed instead. AuthFrame
	// validation is stricter today, so this is defense in depth.
	if err := req.Error(); err != nil {
		return nil, err
	}
	return req.URL(), nil
}

// pingLoop keeps the connection alive and cancels the session when the peer
// stops answering. Once clientGone is closed the peer is known to be gone and
// awaitStream owns the teardown, so a failing ping must not cancel: it would
// land inside the grace period and force the abrupt path.
func (h *Handler) pingLoop(ctx context.Context, conn *websocket.Conn, clientGone <-chan struct{}, cancel context.CancelFunc) {
	ticker := time.NewTicker(h.pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-clientGone:
			return
		case <-ticker.C:
			pingCtx, done := context.WithTimeout(ctx, h.pingTimeout)
			err := conn.Ping(pingCtx)
			done()
			if err != nil {
				// The ping may have raced readLoop noticing the same close.
				select {
				case <-clientGone:
				default:
					cancel()
				}
				return
			}
		}
	}
}
