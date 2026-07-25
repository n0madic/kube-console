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

// stdinBufferLimitBytes is the default cap on stdin staged between readLoop
// and stdinPump for one session (Handler.stdinBufferLimit). Generous for any
// real paste — the read limit caps a single frame at maxSessionFrameBytes —
// while bounding what one session whose command stopped reading input can pin.
const stdinBufferLimitBytes = 8 << 20

// stdinFrameOverheadBytes is charged against the cap per staged frame on top
// of its payload: interactive input arrives as one tiny frame per keystroke,
// and each staged frame costs a slice header and its own allocation, so a
// payload-only account would admit millions of allocations under a byte cap
// they barely dent.
const stdinFrameOverheadBytes = 64

// stdinQueue stages inbound stdin frames between readLoop and stdinPump. push
// never blocks — see readLoop for why the reader must always return to
// conn.Read. The queue is byte-bounded instead: exceeding the cap refuses the
// frame and the caller ends the session with a stated reason, never a silent
// drop, which would corrupt the byte stream the command eventually reads.
type stdinQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	frames [][]byte
	staged int // payload bytes + per-frame overhead currently queued
	limit  int
	closed bool
}

func newStdinQueue(limit int) *stdinQueue {
	q := &stdinQueue{limit: limit}
	q.cond = sync.NewCond(&q.mu)
	return q
}

// push stages one frame, reporting false — with nothing staged — when doing so
// would exceed the byte cap.
func (q *stdinQueue) push(data []byte) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.staged+len(data)+stdinFrameOverheadBytes > q.limit {
		return false
	}
	q.frames = append(q.frames, data)
	q.staged += len(data) + stdinFrameOverheadBytes
	q.cond.Signal()
	return true
}

// close marks the end of input; next drains what is staged, then reports done.
func (q *stdinQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	q.cond.Signal()
}

// next blocks until a frame is staged or the queue is closed and drained.
func (q *stdinQueue) next() ([]byte, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.frames) == 0 && !q.closed {
		q.cond.Wait()
	}
	if len(q.frames) == 0 {
		return nil, false
	}
	data := q.frames[0]
	q.frames[0] = nil
	q.frames = q.frames[1:]
	q.staged -= len(data) + stdinFrameOverheadBytes
	return data, true
}

// readLoop pumps inbound frames: binary → stdin queue, text resize frames →
// size queue. It exits when the connection or context ends, or when the stdin
// queue refuses a frame — overflow() then ends the session with the reason
// stated.
//
// The loop must never block anywhere but conn.Read. The blocking half —
// writing into the stdin pipe, which only completes once the executor picks
// the data up — runs in stdinPump, and the handoff refuses rather than blocks
// when full: a reader parked outside conn.Read would notice neither the
// browser leaving (the whole teardown path keys off this loop returning) nor
// a pong, so coder/websocket's Ping, which needs a concurrent Reader call to
// see its pong, would time out and kill an otherwise healthy session.
func readLoop(ctx context.Context, conn *websocket.Conn, stdin *io.PipeWriter, sizes *sizeQueue, activity func(), stdinLimit int, overflow func()) {
	queue := newStdinQueue(stdinLimit)
	go stdinPump(queue, stdin)
	defer func() {
		// Hand the pump its EOF: it closes stdin once the queue is drained, so
		// input typed just before the disconnect still reaches the process.
		queue.close()
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
			if !queue.push(data) {
				overflow()
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

// stdinPump writes staged frames into the exec stdin pipe and closes it once
// the queue is closed and drained, so the executor observes EOF. A write blocks
// until the executor reads, so this goroutine may outlive readLoop:
// session()'s stdinReader.Close() is what unblocks it on teardown.
func stdinPump(queue *stdinQueue, stdin *io.PipeWriter) {
	defer func() { _ = stdin.Close() }()
	for {
		data, ok := queue.next()
		if !ok {
			return
		}
		if _, err := stdin.Write(data); err != nil {
			return
		}
	}
}
