package httpx

import (
	"net/http"
	"strings"
	"testing"
)

// countingBody reports how much was read and whether Close was called. Reads
// never return EOF, so it stands in for an upstream that would keep feeding a
// body for as long as anyone is willing to read it.
type countingBody struct {
	read   int64
	closed bool
}

func (b *countingBody) Read(p []byte) (int, error) {
	b.read += int64(len(p))
	for i := range p {
		p[i] = 'x'
	}
	return len(p), nil
}

func (b *countingBody) Close() error {
	b.closed = true
	return nil
}

func TestDrainAndCloseBoundsAnEndlessBody(t *testing.T) {
	body := &countingBody{}
	DrainAndClose(&http.Response{Body: body})

	if !body.closed {
		t.Fatal("body was not closed")
	}
	// io.Copy reads in 32 KiB chunks, so the last read may overshoot the limit
	// by less than one chunk; what must not happen is reading on forever.
	if body.read > maxDrainBytes+32<<10 {
		t.Fatalf("drained %d bytes, want at most ~%d: the drain is unbounded", body.read, maxDrainBytes)
	}
	if body.read == 0 {
		t.Fatal("drained nothing: an ordinary short body would lose its connection for no reason")
	}
}

// An ordinary error body — a Kubernetes Status is a few hundred bytes — must be
// consumed whole, or the connection cannot go back in the pool and the bound
// would have cost us keep-alive on every non-2xx.
func TestDrainAndCloseConsumesAnOrdinaryBody(t *testing.T) {
	const payload = `{"kind":"Status","apiVersion":"v1","status":"Failure","code":403}`
	body := &trackedReader{Reader: strings.NewReader(payload)}
	DrainAndClose(&http.Response{Body: body})

	if !body.closed {
		t.Fatal("body was not closed")
	}
	if !body.atEOF {
		t.Fatal("body was not read to EOF: net/http cannot reuse the connection")
	}
}

func TestDrainAndCloseToleratesMissingBody(t *testing.T) {
	// Both shapes reach this helper from defers registered before a response is
	// known to exist.
	DrainAndClose(nil)
	DrainAndClose(&http.Response{})
}

type trackedReader struct {
	*strings.Reader
	closed bool
	atEOF  bool
}

func (r *trackedReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if err != nil {
		r.atEOF = true
	}
	return n, err
}

func (r *trackedReader) Close() error {
	r.closed = true
	return nil
}
