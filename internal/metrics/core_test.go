package metrics

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/n0madic/kube-console/internal/kube"
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

// fixedTransport answers the capability probe with an available group and
// every other request with resp.
type fixedTransport struct{ resp *http.Response }

func (f fixedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Path == metricsGroupPath {
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(
			`{"preferredVersion":{"groupVersion":"metrics.k8s.io/v1beta1","version":"v1beta1"}}`))}, nil
	}
	return f.resp, nil
}

// The core hands an upstream error back as *Error carrying the upstream body
// (forwarded verbatim by the HTTP handlers) and closes the response — the
// connection leak httpx.CopyUpstreamError once guarded against now lives here.
func TestListUpstreamErrorKeepsBodyAndClosesResponse(t *testing.T) {
	body := &trackingBody{Reader: strings.NewReader(
		`{"kind":"Status","reason":"Forbidden","message":"pods.metrics.k8s.io is forbidden","code":403}`)}
	resp := &http.Response{
		StatusCode: http.StatusForbidden,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       body,
	}
	base, _ := url.Parse("https://apiserver.invalid")
	up := &kube.Upstream{BaseURL: base, Transport: fixedTransport{resp: resp}}
	h := NewHandler(kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up}), true)

	_, err := h.List(context.Background(), up, "default", "token", "/pods", true)
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("err = %v, want *Error", err)
	}
	if e.Code != http.StatusForbidden || !strings.Contains(string(e.Body), `"reason":"Forbidden"`) {
		t.Errorf("error = %d %q, want the upstream 403 body", e.Code, e.Body)
	}
	if e.Text() != "pods.metrics.k8s.io is forbidden" {
		t.Errorf("Text() = %q, want the Status message", e.Text())
	}
	if !body.closed {
		t.Error("the upstream error response body was not closed")
	}
}

// A failure kube-console decided itself has no upstream body to forward; its
// text is the adapter's own message.
func TestDisabledCoreError(t *testing.T) {
	h := NewHandler(kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{}), false)
	_, err := h.Get(context.Background(), nil, "default", "", "/nodes/n1", false)
	var e *Error
	if !errors.As(err, &e) || e.Code != http.StatusNotFound || e.Text() != "metrics adapter is disabled" || e.Body != nil {
		t.Errorf("disabled = %#v", err)
	}
}
