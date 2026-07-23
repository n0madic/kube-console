package httpx

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// trackingBody records whether Close was called.
type trackingBody struct {
	io.Reader
	closed bool
}

func (t *trackingBody) Close() error {
	t.closed = true
	return nil
}

// TestCopyUpstreamErrorClosesBody guards against the connection leak where the
// upstream error response body was forwarded but never closed.
func TestCopyUpstreamErrorClosesBody(t *testing.T) {
	body := &trackingBody{Reader: strings.NewReader(`{"kind":"Status","reason":"Forbidden","code":403}`)}
	resp := &http.Response{
		StatusCode: http.StatusForbidden,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       body,
	}

	rec := httptest.NewRecorder()
	CopyUpstreamError(rec, resp)

	if !body.closed {
		t.Fatal("CopyUpstreamError must close resp.Body")
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 forwarded", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Forbidden") {
		t.Fatalf("body not forwarded: %q", rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
}
