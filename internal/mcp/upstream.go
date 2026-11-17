package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/n0madic/kube-console/internal/httpx"
	"github.com/n0madic/kube-console/internal/kube"
)

// Read and output bounds. A tool result lands in a model's context window, so
// what a tool returns is bounded far below what it may read: a list is read up
// to readListBytes and projected down to a few columns per row.
const (
	// maxOutputBytes caps one tool result as returned to the client.
	maxOutputBytes = 1 << 20
	// readObjectBytes caps reading one object: etcd's own limit is 1.5 MiB,
	// and JSON on the wire is somewhat larger than what is stored.
	readObjectBytes = 4 << 20
	// readListBytes caps reading one page of a collection.
	readListBytes = 16 << 20
	// maxStatusBytes caps reading an upstream error body.
	maxStatusBytes = 64 << 10
)

// upstreamError is a non-2xx answer from the apiserver. Its text is the
// apiserver's own Status message ("pods is forbidden: User … cannot list …"),
// which is what lets an agent understand an RBAC denial or a missing object.
type upstreamError struct {
	code    int
	reason  string
	message string
}

func (e *upstreamError) Error() string {
	if e.message == "" {
		return fmt.Sprintf("%d %s", e.code, e.reason)
	}
	return fmt.Sprintf("%d %s: %s", e.code, e.reason, e.message)
}

var (
	// errUnreachable and errTimeout stand in for transport errors, whose text
	// names the apiserver URL — an address no client is ever shown.
	errUnreachable = errors.New("kube-apiserver unreachable")
	errTimeout     = errors.New("kube-apiserver request timed out")
)

// errTooLarge is returned when a response exceeds its read bound.
type errTooLarge struct{ limit int }

func (e errTooLarge) Error() string {
	return fmt.Sprintf("response exceeds %d bytes; narrow the request (a smaller limit, a namespace or a selector)", e.limit)
}

// get issues one GET on behalf of the caller and returns the body, read up to
// limit bytes. truncated reports that the body was longer; callers that cannot
// use a partial body treat it as errTooLarge.
func get(ctx context.Context, c caller, path string, query url.Values, accept string, limit int) (body []byte, truncated bool, err error) {
	body, truncated, _, err = send(ctx, c, http.MethodGet, path, query, accept, "", nil, limit)
	return body, truncated, err
}

// send issues one request on behalf of the caller. contentType and payload
// describe the request body (none when payload is nil). It returns the 2xx
// status alongside the body, since a write tool reports 201 (created) apart
// from 200.
func send(ctx context.Context, c caller, method, path string, query url.Values, accept, contentType string, payload []byte, limit int) (body []byte, truncated bool, status int, err error) {
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	header := http.Header{}
	header.Set("Accept", accept)
	var reqBody io.Reader
	if payload != nil {
		header.Set("Content-Type", contentType)
		reqBody = bytes.NewReader(payload)
	}
	resp, err := kube.Do(ctx, c.up, c.token, method, path, header, reqBody)
	if err != nil {
		if ctx.Err() != nil {
			return nil, false, 0, errTimeout
		}
		return nil, false, 0, errUnreachable
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, false, 0, statusError(resp, c.token)
	}
	defer httpx.DrainAndClose(resp)
	body, err = io.ReadAll(io.LimitReader(resp.Body, int64(limit)+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, false, 0, errTimeout
		}
		return nil, false, 0, errUnreachable
	}
	if len(body) > limit {
		return body[:limit], true, resp.StatusCode, nil
	}
	return body, false, resp.StatusCode, nil
}

// getJSON is get for a JSON document that must arrive whole. Numbers decode as
// json.Number, so an int64 past 2^53 survives the round trip to the client.
func getJSON(ctx context.Context, c caller, path string, query url.Values, accept string, limit int, v any) error {
	body, truncated, err := get(ctx, c, path, query, accept, limit)
	if err != nil {
		return err
	}
	if truncated {
		return errTooLarge{limit: limit}
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(v); err != nil {
		return errors.New("unexpected response from kube-apiserver")
	}
	return nil
}

// statusError turns a non-2xx response into an upstreamError, preferring the
// Kubernetes Status message, and drains the body boundedly. The apiserver does
// not echo credentials, but whatever sits in front of it (an aggregated API,
// an auth proxy) is not held to that, and this text goes to the model: the
// caller's token is scrubbed from it regardless.
func statusError(resp *http.Response, token string) error {
	defer httpx.DrainAndClose(resp)
	e := &upstreamError{code: resp.StatusCode, reason: http.StatusText(resp.StatusCode)}
	var status struct {
		Reason  string `json:"reason"`
		Message string `json:"message"`
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxStatusBytes))
	if json.Unmarshal(raw, &status) == nil {
		if status.Reason != "" {
			e.reason = scrub(status.Reason, token)
		}
		e.message = scrub(strings.TrimSpace(status.Message), token)
	}
	return e
}

// scrub removes the caller's token from upstream text bound for the model.
func scrub(s, token string) string {
	if token == "" {
		return s
	}
	return strings.ReplaceAll(s, token, "<redacted>")
}

// outcome classifies an error for the per-call log line without its text.
func outcome(err error) string {
	var ue *upstreamError
	switch {
	case err == nil:
		return "ok"
	case errors.As(err, &ue):
		return fmt.Sprintf("upstream %d", ue.code)
	case errors.Is(err, errTimeout):
		return "timeout"
	case errors.Is(err, errUnreachable):
		return "unreachable"
	default:
		return "error"
	}
}
