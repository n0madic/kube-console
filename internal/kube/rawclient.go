package kube

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"
)

// DefaultUnaryTimeout bounds a single unary Do call — the short, fully
// buffered requests the UI adapters (auth, discovery, metrics) make, unlike
// the gateway's intentionally-unbounded watch/log streams. Adapters wrap Do's
// ctx with this so a stalled kube-apiserver cannot pin the request goroutine
// for as long as the client keeps its socket open.
const DefaultUnaryTimeout = 30 * time.Second

// Do performs a raw HTTP request against the upstream kube-apiserver on
// behalf of the user token. It is used by the UI adapters (auth, discovery,
// metrics) that need small, targeted API calls without a clientset.
//
// path must be an absolute, already-escaped URL path (may include a query
// string). The caller owns the response body. There is deliberately no client
// timeout — callers control cancellation via ctx.
func Do(ctx context.Context, up *Upstream, token, method, path string, header http.Header, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, up.BaseURL.String()+path, body)
	if err != nil {
		return nil, fmt.Errorf("build upstream request: %w", err)
	}
	for k, vs := range header {
		req.Header[k] = vs
	}
	client := &http.Client{
		Transport: WithBearer(up.Transport, token),
		// Never follow redirects: WithBearer re-attaches the bearer token on
		// every hop, which would leak it to a redirect target. Hand the 3xx
		// back to the caller unchanged instead.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return client.Do(req)
}
