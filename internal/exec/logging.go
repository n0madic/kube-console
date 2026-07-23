package exec

import (
	"context"
	"log/slog"
	"sync/atomic"

	"github.com/go-logr/logr"
)

// debugLogr wraps our slog logger as the contextual (logr/klog) logger
// client-go expects, demoting everything it logs to debug level. Everything
// client-go emits during a session is either progress detail or end-of-session
// teardown noise from closing the upstream connection; the failures that matter
// are returned by StreamWithContext and surface as an error frame.
//
// quiet drops the output entirely once set. From the moment the session is over
// — the browser left, or we cancelled — client-go only narrates its own
// teardown: the copy goroutines it abandoned and the heartbeat it left running
// all fail on the connection it closes itself ("use of closed network
// connection"), describing an outcome we already decided and nobody can act on.
func debugLogr(l *slog.Logger, quiet *atomic.Bool) logr.Logger {
	return logr.FromSlogHandler(demoteHandler{Handler: l.Handler(), quiet: quiet})
}

// minVerbosity is the deepest klog verbosity kept. logr encodes V(n) as slog
// level -n, so this is V(4): once-per-session milestones ("Subprotocol
// negotiated"). Deeper levels log per I/O operation — V(8) writes a line for
// every stdin frame, i.e. every keystroke — and V(6)+ additionally switches
// client-go's debugging RoundTripper into URL/curl logging, so they are dropped
// even with debug logging on.
const minVerbosity = slog.LevelDebug // == -4

// demoteHandler rewrites every record it keeps to debug level. logr emits
// Error() calls unconditionally (no Enabled check), so Handle re-checks the
// level itself — slog handlers do not.
type demoteHandler struct {
	slog.Handler
	quiet *atomic.Bool
}

func (h demoteHandler) Enabled(ctx context.Context, level slog.Level) bool {
	if h.quiet != nil && h.quiet.Load() {
		return false
	}
	return level >= minVerbosity && h.Handler.Enabled(ctx, slog.LevelDebug)
}

func (h demoteHandler) Handle(ctx context.Context, rec slog.Record) error {
	if !h.Enabled(ctx, rec.Level) {
		return nil
	}
	rec.Level = slog.LevelDebug
	return h.Handler.Handle(ctx, rec)
}

func (h demoteHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return demoteHandler{Handler: h.Handler.WithAttrs(attrs), quiet: h.quiet}
}

func (h demoteHandler) WithGroup(name string) slog.Handler {
	return demoteHandler{Handler: h.Handler.WithGroup(name), quiet: h.quiet}
}
