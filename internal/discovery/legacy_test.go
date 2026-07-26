package discovery

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

// Regression: getJSON drained the body it is not going to read with an
// unbounded io.Copy, so how long that courtesy takes was the upstream's choice
// — and it is paid while the request holds an in-flight slot. The upstream here
// sends far more than httpx's drain bound and then never reaches EOF, so an
// unbounded drain blocks forever while a bounded one stops at its limit, closes
// the connection and returns the status.
//
// The context is deliberately background: a deadline would rescue the old code
// and turn "returns promptly" into "returns eventually as a context error".
func TestGetJSONReturnsWithoutDrainingAnEndlessBody(t *testing.T) {
	const wantWithin = 3 * time.Second

	stop := make(chan struct{})
	up := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		// Write errors are expected once the client closes the undrained body.
		_, _ = w.Write(bytes.Repeat([]byte("x"), 1<<20))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-stop // no EOF: the body only ends when the test does
	})
	// Registered after newUpstream's ts.Close, so it runs first (cleanups are
	// LIFO) and the stalled handler cannot wedge httptest.Server.Close.
	t.Cleanup(func() { close(stop) })

	done := make(chan error, 1)
	go func() {
		var v map[string]any
		done <- getJSON(context.Background(), up, "tok", "/api", &v)
	}()

	select {
	case err := <-done:
		var se *statusError
		if !errors.As(err, &se) || se.code != http.StatusInternalServerError {
			t.Fatalf("err = %v, want a statusError 500", err)
		}
	case <-time.After(wantWithin):
		t.Fatalf("getJSON did not return within %s: the unread-body drain is unbounded", wantWithin)
	}
}
