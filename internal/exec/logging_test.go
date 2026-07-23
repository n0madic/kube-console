package exec

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
)

// quiet is what the session flips when it is over: from then on client-go only
// narrates the teardown of a connection it closes itself.
func TestDebugLogrGoesSilentWhenQuiet(t *testing.T) {
	buf := &bytes.Buffer{}
	var quiet atomic.Bool
	logger := debugLogr(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})), &quiet)

	logger.Info("Subprotocol negotiated")
	if !strings.Contains(buf.String(), "Subprotocol negotiated") {
		t.Fatalf("expected the message before teardown, got %q", buf.String())
	}

	buf.Reset()
	quiet.Store(true)
	logger.Error(errors.New("use of closed network connection"), "Copying stdout failed")
	logger.Info("Websocket Ping failed")
	// Derived loggers (client-go passes them around) must go quiet too.
	logger.WithName("stream").WithValues("id", 1).Error(errors.New("boom"), "Reset() on stream")
	if buf.Len() != 0 {
		t.Fatalf("teardown narration reached the log: %q", buf.String())
	}
}

// client-go logs its end-of-session teardown at error level; at the default
// log level it must not reach the log at all, and never at error level.
func TestDebugLogrDemotesClientGoErrors(t *testing.T) {
	buf := &bytes.Buffer{}
	logger := debugLogr(slog.New(slog.NewTextHandler(buf, nil)), nil) // info level
	logger.Error(errors.New("use of closed network connection"), "Copying stdout failed")
	if buf.Len() != 0 {
		t.Fatalf("client-go teardown noise reached an info-level log: %q", buf.String())
	}

	buf.Reset()
	logger = debugLogr(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})), nil)
	logger.Error(errors.New("use of closed network connection"), "Copying stdout failed")
	out := buf.String()
	if !strings.Contains(out, "level=DEBUG") || !strings.Contains(out, "Copying stdout failed") {
		t.Fatalf("expected the message at debug level, got %q", out)
	}
}

// Verbosity must survive the demotion: client-go logs a line per stdin frame
// at V(8), so only the shallow levels are kept when debug logging is on.
func TestDebugLogrKeepsVerbosityThreshold(t *testing.T) {
	buf := &bytes.Buffer{}
	logger := debugLogr(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})), nil)

	logger.V(8).Info("Write() on stream")
	logger.V(6).Info("Websocket Ping succeeeded")
	if buf.Len() != 0 {
		t.Fatalf("per-I/O client-go chatter reached the log: %q", buf.String())
	}
	// V(9).Enabled() gates client-go's URL/curl request logging.
	if logger.V(9).Enabled() {
		t.Fatal("V(9) must stay disabled: it switches client-go to logging request URLs")
	}

	logger.V(4).Info("Subprotocol negotiated")
	if !strings.Contains(buf.String(), "Subprotocol negotiated") {
		t.Fatalf("once-per-session milestones must survive, got %q", buf.String())
	}
}

// WithValues/WithName must keep the demotion (logr wraps the handler).
func TestDebugLogrDemotesThroughDerivedLoggers(t *testing.T) {
	buf := &bytes.Buffer{}
	logger := debugLogr(slog.New(slog.NewTextHandler(buf, nil)), nil).WithName("exec").WithValues("k", "v")
	logger.Error(errors.New("boom"), "Websocket Ping failed")
	if buf.Len() != 0 {
		t.Fatalf("derived logger escaped the demotion: %q", buf.String())
	}
}
