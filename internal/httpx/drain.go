package httpx

import (
	"io"
	"net/http"
)

// maxDrainBytes bounds how much of an unread response body is consumed for the
// sake of connection reuse. Every adapter that stops reading an upstream
// response early (a non-2xx, a decode failure, a probe that only wants the
// status) has to drain before Close or net/http cannot put the connection back
// in the pool — but an unbounded drain makes the size of that courtesy the
// upstream's choice, and it is paid while holding an in-flight slot.
//
// 64 KiB is far more than any Kubernetes Status or APIGroup body, so ordinary
// responses are still drained whole and their connections still reused; a body
// larger than that loses its connection instead of spending our time. That is
// the right way round: keep-alive is an optimization, and a response nobody is
// reading is not worth streaming to /dev/null.
const maxDrainBytes = 64 << 10

// DrainAndClose consumes a bounded prefix of resp.Body and closes it, so the
// upstream connection can be reused. Safe to call on a partially read body and
// on a body that is already at EOF, which is what makes it usable from a defer
// registered before the response is inspected.
func DrainAndClose(resp *http.Response) {
	if resp == nil || resp.Body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxDrainBytes))
	_ = resp.Body.Close()
}
