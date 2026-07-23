package exec

import (
	"context"
	"encoding/json"
	"io"
	"sync"

	"github.com/coder/websocket"
	"k8s.io/client-go/tools/remotecommand"
)

// sizeQueue feeds terminal resize events to the remotecommand executor.
type sizeQueue struct {
	ch   chan remotecommand.TerminalSize
	done chan struct{}
	once sync.Once
}

func newSizeQueue() *sizeQueue {
	return &sizeQueue{
		ch:   make(chan remotecommand.TerminalSize, 8),
		done: make(chan struct{}),
	}
}

// Next blocks until a resize arrives; nil ends the executor's resize loop.
func (q *sizeQueue) Next() *remotecommand.TerminalSize {
	select {
	case size := <-q.ch:
		return &size
	case <-q.done:
		return nil
	}
}

// push enqueues a resize, dropping it if the executor is not keeping up.
func (q *sizeQueue) push(cols, rows uint16) {
	select {
	case q.ch <- remotecommand.TerminalSize{Width: cols, Height: rows}:
	default:
	}
}

func (q *sizeQueue) close() {
	q.once.Do(func() { close(q.done) })
}

// wsWriter adapts stdout of the exec stream to binary WebSocket frames.
// A shared mutex serializes data and control frames on the connection.
type wsWriter struct {
	ctx      context.Context
	conn     *websocket.Conn
	mu       *sync.Mutex
	activity func()
}

func (w *wsWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.conn.Write(w.ctx, websocket.MessageBinary, p); err != nil {
		return 0, err
	}
	if w.activity != nil {
		w.activity()
	}
	return len(p), nil
}

// writeControl sends a JSON control frame (ready/error/exit) as text.
func writeControl(ctx context.Context, conn *websocket.Conn, mu *sync.Mutex, frame ControlFrame) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	mu.Lock()
	defer mu.Unlock()
	return conn.Write(ctx, websocket.MessageText, data)
}

// stdinQueueDepth bounds the frames buffered between readLoop and stdinPump.
// Each frame is at most maxSessionFrameBytes, so the queue stays bounded; a
// few frames are plenty to keep the reader inside conn.Read across an ordinary
// paste burst, and a full queue simply blocks the reader again — backpressure,
// never dropped input.
const stdinQueueDepth = 8

// readLoop pumps inbound frames: binary → stdin queue, text resize frames →
// size queue. It exits when the connection or context ends.
//
// The blocking half — writing into the stdin pipe, which only completes once
// the executor picks the data up — runs in stdinPump, never here. A reader
// parked in that write would notice neither the browser leaving (the whole
// teardown path keys off this loop returning) nor a pong, so coder/websocket's
// Ping, which waits for a Reader call to read it, would time out and kill an
// otherwise healthy session.
func readLoop(ctx context.Context, conn *websocket.Conn, stdin *io.PipeWriter, sizes *sizeQueue, activity func()) {
	frames := make(chan []byte, stdinQueueDepth)
	go stdinPump(frames, stdin)
	defer func() {
		// Hand the pump its EOF: it closes stdin once the queue is drained, so
		// input typed just before the disconnect still reaches the process.
		close(frames)
		sizes.close()
	}()
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if activity != nil {
			activity()
		}
		switch typ {
		case websocket.MessageBinary:
			// conn.Read allocates a fresh buffer per frame, so handing it over
			// is safe.
			select {
			case frames <- data:
			case <-ctx.Done():
				return
			}
		case websocket.MessageText:
			if len(data) > maxControlFrameBytes {
				continue
			}
			var frame ResizeFrame
			if json.Unmarshal(data, &frame) == nil && frame.Type == "resize" {
				sizes.push(frame.Cols, frame.Rows)
			}
		}
	}
}

// stdinPump writes queued frames into the exec stdin pipe and closes it once
// the queue is closed and drained, so the executor observes EOF. A write blocks
// until the executor reads, so this goroutine may outlive readLoop:
// session()'s stdinReader.Close() is what unblocks it on teardown.
func stdinPump(frames <-chan []byte, stdin *io.PipeWriter) {
	defer func() { _ = stdin.Close() }()
	for data := range frames {
		if _, err := stdin.Write(data); err != nil {
			return
		}
	}
}
