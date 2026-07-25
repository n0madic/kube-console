package gateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"

	"k8s.io/client-go/rest"

	"github.com/n0madic/kube-console/internal/httpx"
	"github.com/n0madic/kube-console/internal/kube"
)

type recordedRequest struct {
	Method string
	Path   string
	Query  string
	Host   string
	Header http.Header
	Body   []byte
}

// recorder is what the fake upstreams write into. It is guarded because the
// handler runs on the httptest server's goroutine while the test reads from its
// own: for most cases the response the test waited for carries a happens-before
// edge to the append, but not for every case — the gateway answers a 413 having
// never waited for the upstream at all, so that read raced the append (CI, -race).
type recorder struct {
	mu       sync.Mutex
	requests []recordedRequest
}

func (r *recorder) add(req recordedRequest) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.requests = append(r.requests, req)
}

// all returns a snapshot: the caller must not hold a slice the upstream can
// still append to.
func (r *recorder) all() []recordedRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.requests)
}

func newTestGateway(t *testing.T, upstream http.HandlerFunc) (*Gateway, *recorder, *httptest.Server) {
	t.Helper()
	recorded := &recorder{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		recorded.add(recordedRequest{
			Method: r.Method,
			Path:   r.URL.Path,
			Query:  r.URL.RawQuery,
			Host:   r.Host,
			Header: r.Header.Clone(),
			Body:   body,
		})
		if upstream != nil {
			upstream(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ts.Close)
	base, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	up := &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport}
	reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up})
	return New(reg, slog.New(slog.DiscardHandler)), recorded, ts
}

func doGateway(gw *Gateway, method, target string, header http.Header, body io.Reader) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, body)
	for k, vs := range header {
		req.Header[k] = vs
	}
	rec := httptest.NewRecorder()
	gw.ServeHTTP(rec, req)
	return rec
}

func bearerHeader() http.Header {
	h := http.Header{}
	h.Set("Authorization", "Bearer test-token")
	return h
}

func TestGatewayBlockedSubresourcesNeverReachUpstream(t *testing.T) {
	gw, recorded, _ := newTestGateway(t, nil)
	blocked := []string{
		"/k8s/api/v1/namespaces/ns/pods/p/exec",
		"/k8s/api/v1/namespaces/ns/pods/p/attach",
		"/k8s/api/v1/namespaces/ns/pods/p/portforward",
		"/k8s/api/v1/namespaces/ns/services/s/proxy",
	}
	for _, p := range blocked {
		rec := doGateway(gw, http.MethodGet, p, bearerHeader(), nil)
		if rec.Code != http.StatusForbidden {
			t.Errorf("GET %s = %d, want 403", p, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
			t.Errorf("GET %s Content-Type = %q, want JSON", p, ct)
		}
		var status map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
			t.Errorf("GET %s body is not JSON: %v", p, err)
		} else if status["kind"] != "Status" {
			t.Errorf("GET %s body kind = %v, want Status", p, status["kind"])
		}
	}
	if len(recorded.all()) != 0 {
		t.Fatalf("upstream was called %d times for blocked paths", len(recorded.all()))
	}
}

func TestGatewayLogSubresourcePasses(t *testing.T) {
	gw, recorded, _ := newTestGateway(t, nil)
	rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/namespaces/ns/pods/p/log?tailLines=100", bearerHeader(), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if len(recorded.all()) != 1 {
		t.Fatalf("upstream called %d times, want 1", len(recorded.all()))
	}
	got := recorded.all()[0]
	if got.Path != "/api/v1/namespaces/ns/pods/p/log" {
		t.Errorf("upstream path = %q", got.Path)
	}
	if got.Query != "tailLines=100" {
		t.Errorf("upstream query = %q", got.Query)
	}
}

func TestIsStreaming(t *testing.T) {
	cases := []struct {
		name   string
		target string
		want   bool
	}{
		{"watch true", "/k8s/api/v1/pods?watch=true", true},
		{"watch numeric bool", "/k8s/api/v1/pods?watch=1", true},
		{"watch false", "/k8s/api/v1/pods?watch=false", false},
		{"watch false uppercase", "/k8s/api/v1/pods?watch=FALSE", false},
		{"watch zero", "/k8s/api/v1/pods?watch=0", false},
		{"plain list", "/k8s/api/v1/pods", false},
		// The apiserver decodes booleans via Convert_Slice_string_To_bool:
		// any present value other than "0"/"false" streams — including a
		// present-but-empty one, which strconv.ParseBool would call false.
		{"watch yes", "/k8s/api/v1/pods?watch=yes", true},
		{"watch on", "/k8s/api/v1/pods?watch=on", true},
		{"watch two", "/k8s/api/v1/pods?watch=2", true},
		{"watch arbitrary value", "/k8s/api/v1/pods?watch=maybe", true},
		{"watch present but empty", "/k8s/api/v1/pods?watch=", true},
		{"watch bare key", "/k8s/api/v1/pods?watch", true},
		{"log follow", "/k8s/api/v1/namespaces/ns/pods/p/log?follow=true", true},
		{"log follow non-canonical", "/k8s/api/v1/namespaces/ns/pods/p/log?follow=yes", true},
		{"log without follow", "/k8s/api/v1/namespaces/ns/pods/p/log?tailLines=100", false},
		{"follow on non-log path", "/k8s/api/v1/namespaces/ns/pods/p?follow=true", false},
		// The legacy watch prefix streams with no query parameter at all.
		{"legacy core watch", "/k8s/api/v1/watch/pods", true},
		{"legacy core namespaced watch", "/k8s/api/v1/watch/namespaces/ns/pods", true},
		{"legacy group watch", "/k8s/apis/apps/v1/watch/namespaces/ns/deployments", true},
		// "watch" outside the prefix position is an ordinary object name.
		{"object named watch", "/k8s/api/v1/namespaces/default/configmaps/watch", false},
		{"resource list under group", "/k8s/apis/apps/v1/deployments?limit=1", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.target, nil)
			if got := IsStreaming(req); got != tc.want {
				t.Errorf("IsStreaming(%q) = %v, want %v", tc.target, got, tc.want)
			}
		})
	}
}

// Regression for rewriteFor: ReverseProxy re-encodes the inbound query
// (CVE-2022-2880) immediately before Rewrite runs, and the gateway used to
// copy pr.In's RawQuery back over Out, restoring semicolon-separated
// parameters and malformed percent-escapes verbatim.
func TestGatewayQueryKeepsStdlibSanitization(t *testing.T) {
	gw, recorded, _ := newTestGateway(t, nil)
	rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods?watch=true;evil=1&limit=500&bad=%zz", bearerHeader(), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if len(recorded.all()) != 1 {
		t.Fatalf("upstream called %d times, want 1", len(recorded.all()))
	}
	got := recorded.all()[0].Query
	if strings.Contains(got, ";") || strings.Contains(got, "evil") || strings.Contains(got, "%zz") {
		t.Fatalf("upstream query = %q: unparsable parameters must not survive", got)
	}
	if !strings.Contains(got, "limit=500") {
		t.Errorf("upstream query = %q, want the well-formed limit=500 kept", got)
	}
}

func TestGatewayWellFormedQueryPassesUnchanged(t *testing.T) {
	gw, recorded, _ := newTestGateway(t, nil)
	const query = "watch=true&limit=500&continue=abc&labelSelector=app%3Ddemo"
	rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods?"+query, bearerHeader(), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if len(recorded.all()) != 1 {
		t.Fatalf("upstream called %d times, want 1", len(recorded.all()))
	}
	if got := recorded.all()[0].Query; got != query {
		t.Errorf("upstream query = %q, want %q unchanged", got, query)
	}
}

// Regression: a shutdown abort used to fall into the silent client-gone
// branch, and net/http then completed the response as an empty 200 — a clean
// end of stream to a watch client. The cause is cancelled here directly, so
// the test does not depend on how AbortOnShutdown wires it.
func TestGatewayShutdownAbortAnswers503(t *testing.T) {
	inUpstream := make(chan struct{})
	gw, _, _ := newTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		close(inUpstream)
		<-r.Context().Done()
	})
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	req := httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods?watch=true", nil).WithContext(ctx)
	req.Header = bearerHeader()
	go func() {
		<-inUpstream
		cancel(httpx.ErrShutdown)
	}()
	rec := httptest.NewRecorder()
	gw.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	var status map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatalf("503 body is not JSON: %v", err)
	}
	if status["kind"] != "Status" {
		t.Errorf("body kind = %v, want Status", status["kind"])
	}
	if !strings.Contains(rec.Body.String(), "shutting down") {
		t.Errorf("body = %q, want it to say the server is shutting down", rec.Body.String())
	}
}

// The counterpart: a plain cancellation with no shutdown cause is a departed
// client, and nothing must be written for one.
func TestGatewayClientGoneStaysSilent(t *testing.T) {
	inUpstream := make(chan struct{})
	gw, _, _ := newTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		close(inUpstream)
		<-r.Context().Done()
	})
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods?watch=true", nil).WithContext(ctx)
	req.Header = bearerHeader()
	go func() {
		<-inUpstream
		cancel()
	}()
	rec := httptest.NewRecorder()
	gw.ServeHTTP(rec, req)
	if rec.Body.Len() != 0 {
		t.Fatalf("body = %q, want nothing written for a departed client", rec.Body.String())
	}
}

func TestGatewayHeaderSanitization(t *testing.T) {
	gw, recorded, ts := newTestGateway(t, nil)
	h := bearerHeader()
	h.Set("Cookie", "session=abc")
	h.Set("Impersonate-User", "admin")
	h.Set("X-Remote-User", "admin")
	h.Set("X-Forwarded-For", "1.2.3.4")
	h.Set("Forwarded", "for=1.2.3.4")
	h.Set("Referer", "https://spa.example/page")
	h.Set("Accept", "application/json;as=Table;g=meta.k8s.io;v=v1")
	rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods", h, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	got := recorded.all()[0]
	for _, name := range []string{"Cookie", "Impersonate-User", "X-Remote-User", "X-Forwarded-For", "Forwarded", "Referer"} {
		if v := got.Header.Get(name); v != "" {
			t.Errorf("upstream received %s = %q, want removed", name, v)
		}
	}
	if v := got.Header.Get("Authorization"); v != "Bearer test-token" {
		t.Errorf("upstream Authorization = %q, want passthrough", v)
	}
	if v := got.Header.Get("Accept"); v != "application/json;as=Table;g=meta.k8s.io;v=v1" {
		t.Errorf("upstream Accept = %q, want passthrough", v)
	}
	wantHost := strings.TrimPrefix(ts.URL, "http://")
	if got.Host != wantHost {
		t.Errorf("upstream Host = %q, want %q (from config)", got.Host, wantHost)
	}
}

func TestGatewayMissingBearer(t *testing.T) {
	gw, recorded, _ := newTestGateway(t, nil)
	rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods", nil, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if len(recorded.all()) != 0 {
		t.Fatal("upstream must not be called without a bearer token")
	}
}

func TestGatewayRejectsInboundUpgrade(t *testing.T) {
	gw, recorded, _ := newTestGateway(t, nil)
	h := bearerHeader()
	h.Set("Connection", "Upgrade")
	h.Set("Upgrade", "websocket")
	rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods", h, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if len(recorded.all()) != 0 {
		t.Fatal("upstream must not be called for upgrade requests")
	}
}

func TestGatewayMethodNotAllowed(t *testing.T) {
	gw, recorded, _ := newTestGateway(t, nil)
	for _, m := range []string{http.MethodOptions, http.MethodConnect, "TRACE"} {
		rec := doGateway(gw, m, "/k8s/api/v1/pods", bearerHeader(), nil)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s status = %d, want 405", m, rec.Code)
		}
	}
	if len(recorded.all()) != 0 {
		t.Fatal("upstream must not be called for disallowed methods")
	}
}

func TestGatewayErrorPassthrough(t *testing.T) {
	statusBody := `{"kind":"Status","apiVersion":"v1","status":"Failure","message":"pods is forbidden","reason":"Forbidden","code":403}`
	gw, _, _ := newTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(statusBody))
	})
	rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods", bearerHeader(), nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 passthrough", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != statusBody {
		t.Errorf("body = %q, want upstream Status passthrough", rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
}

func TestGatewayStreamingResponse(t *testing.T) {
	release := make(chan struct{})
	gw, _, _ := newTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		fl := w.(http.Flusher)
		_, _ = w.Write([]byte("chunk-one\n"))
		fl.Flush()
		<-release
		_, _ = w.Write([]byte("chunk-two\n"))
		fl.Flush()
	})
	front := httptest.NewServer(gw)
	defer front.Close()

	req, _ := http.NewRequest(http.MethodGet, front.URL+"/k8s/api/v1/namespaces/ns/pods/p/log?follow=true", nil)
	req.Header = bearerHeader()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)
	line1, err := reader.ReadString('\n')
	if err != nil || line1 != "chunk-one\n" {
		t.Fatalf("first chunk = %q, err %v: streaming must deliver data before upstream finishes", line1, err)
	}
	close(release)
	line2, err := reader.ReadString('\n')
	if err != nil || line2 != "chunk-two\n" {
		t.Fatalf("second chunk = %q, err %v", line2, err)
	}
}

func TestGatewayBodyTooLarge(t *testing.T) {
	gw, recorded, upstream := newTestGateway(t, nil)
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 16)
		gw.ServeHTTP(w, r)
	}))
	defer front.Close()

	req, _ := http.NewRequest(http.MethodPost, front.URL+"/k8s/api/v1/namespaces/ns/pods",
		strings.NewReader(strings.Repeat("x", 1024)))
	req.Header = bearerHeader()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", resp.StatusCode)
	}
	var status map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		t.Fatalf("413 body is not JSON: %v", err)
	}
	// The 413 is written without waiting for the upstream, so the request it
	// aborted may still be in that handler. Close waits for it (and is
	// idempotent, so the t.Cleanup close stays fine): otherwise this loop could
	// read an empty log and pass without ever seeing what reached upstream.
	upstream.Close()
	for _, rr := range recorded.all() {
		if len(rr.Body) > 16 {
			t.Fatal("oversized body must not fully reach upstream")
		}
	}
}

// newMultiContextGateway wires two recording upstreams (alpha default + beta)
// so context routing and header stripping can be asserted.
func newMultiContextGateway(t *testing.T) (*Gateway, *recorder, *recorder) {
	t.Helper()
	newUpstream := func() (*kube.Upstream, *recorder) {
		recorded := &recorder{}
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			recorded.add(recordedRequest{
				Method: r.Method,
				Path:   r.URL.Path,
				Header: r.Header.Clone(),
			})
			w.WriteHeader(http.StatusOK)
		}))
		t.Cleanup(ts.Close)
		base, _ := url.Parse(ts.URL)
		return &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport}, recorded
	}
	alpha, alphaRec := newUpstream()
	beta, betaRec := newUpstream()
	reg := kube.NewRegistryFromUpstreams("alpha", map[string]*kube.Upstream{"alpha": alpha, "beta": beta})
	return New(reg, slog.New(slog.DiscardHandler)), alphaRec, betaRec
}

func TestGatewayRoutesByContextHeader(t *testing.T) {
	gw, alphaRec, betaRec := newMultiContextGateway(t)

	// No header → default (alpha).
	if rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods", bearerHeader(), nil); rec.Code != http.StatusOK {
		t.Fatalf("default route status = %d", rec.Code)
	}
	if len(alphaRec.all()) != 1 || len(betaRec.all()) != 0 {
		t.Fatalf("default routing: alpha=%d beta=%d, want alpha", len(alphaRec.all()), len(betaRec.all()))
	}

	// Explicit beta header → beta upstream.
	h := bearerHeader()
	h.Set("X-Kube-Context", "beta")
	if rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods", h, nil); rec.Code != http.StatusOK {
		t.Fatalf("beta route status = %d", rec.Code)
	}
	if len(alphaRec.all()) != 1 || len(betaRec.all()) != 1 {
		t.Fatalf("beta routing: alpha=%d beta=%d, want beta", len(alphaRec.all()), len(betaRec.all()))
	}
}

func TestGatewayUnknownContextRejected(t *testing.T) {
	gw, alphaRec, betaRec := newMultiContextGateway(t)
	h := bearerHeader()
	h.Set("X-Kube-Context", "ghost")
	rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods", h, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown context status = %d, want 400", rec.Code)
	}
	if len(alphaRec.all()) != 0 || len(betaRec.all()) != 0 {
		t.Fatalf("unknown context reached an upstream: alpha=%d beta=%d", len(alphaRec.all()), len(betaRec.all()))
	}
}

// The router header must never be forwarded upstream.
func TestGatewayContextHeaderStrippedFromUpstream(t *testing.T) {
	gw, _, betaRec := newMultiContextGateway(t)
	h := bearerHeader()
	h.Set("X-Kube-Context", "beta")
	if rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods", h, nil); rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if len(betaRec.all()) != 1 {
		t.Fatalf("beta upstream calls = %d, want 1", len(betaRec.all()))
	}
	if leaked := betaRec.all()[0].Header.Get("X-Kube-Context"); leaked != "" {
		t.Fatalf("X-Kube-Context leaked upstream: %q", leaked)
	}
}

func TestGatewayAuthorizationNotEchoedInErrors(t *testing.T) {
	base, _ := url.Parse("http://127.0.0.1:1") // guaranteed connection refused
	up := &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport}
	reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up})
	gw := New(reg, slog.New(slog.DiscardHandler))
	const sentinel = "SENTINEL-token-do-not-leak"
	h := http.Header{}
	h.Set("Authorization", "Bearer "+sentinel)
	rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods", h, nil)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if strings.Contains(rec.Body.String(), sentinel) {
		t.Fatal("error response leaked the bearer token")
	}
}

// The 502 log line must carry the transport error (an errorHandler that drops
// err makes x509, DNS, refused-connection and timeout failures one identical
// line) — but never anything from the request: not the query string, not a
// header, not the bearer.
func TestGatewayUpstreamErrorLoggedWithoutRequestContents(t *testing.T) {
	base, _ := url.Parse("http://127.0.0.1:1") // guaranteed connection refused
	up := &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport}
	reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up})
	var logBuf bytes.Buffer
	gw := New(reg, slog.New(slog.NewTextHandler(&logBuf, nil)))
	const querySentinel = "SENTINEL-query-do-not-log"
	const headerSentinel = "SENTINEL-header-do-not-log"
	const tokenSentinel = "SENTINEL-token-do-not-log"
	h := http.Header{}
	h.Set("Authorization", "Bearer "+tokenSentinel)
	h.Set("X-Sentinel", headerSentinel)
	rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods?labelSelector="+querySentinel, h, nil)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	logs := logBuf.String()
	if !strings.Contains(logs, "connection refused") {
		t.Errorf("log %q does not carry the transport error; the 502 is undiagnosable without it", logs)
	}
	for _, sentinel := range []string{querySentinel, headerSentinel, tokenSentinel} {
		if strings.Contains(logs, sentinel) {
			t.Errorf("log leaked request contents %q: %q", sentinel, logs)
		}
	}
}

// newCredentialedGateway wires the --use-kubeconfig-credentials carve-out the
// way NewUpstream does: the transport is client-go's own, built from a
// rest.Config that carries the kubeconfig's bearer token, so the test exercises
// client-go's real "do not overwrite an existing Authorization" behaviour
// rather than a stand-in for it.
func newCredentialedGateway(t *testing.T, configToken string) (*Gateway, *recorder) {
	t.Helper()
	recorded := &recorder{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorded.add(recordedRequest{
			Method: r.Method,
			Path:   r.URL.Path,
			Header: r.Header.Clone(),
		})
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ts.Close)
	base, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	rt, err := rest.TransportFor(&rest.Config{Host: ts.URL, BearerToken: configToken})
	if err != nil {
		t.Fatal(err)
	}
	up := &kube.Upstream{BaseURL: base, Transport: rt, UseConfigCredentials: true}
	reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up})
	return New(reg, slog.New(slog.DiscardHandler)), recorded
}

// In the carve-out the browser sends no token at all, and the request must
// still be proxied — authenticated with the kubeconfig's credentials.
func TestGatewayConfigCredentialsWithoutInboundBearer(t *testing.T) {
	gw, recorded := newCredentialedGateway(t, "kubeconfig-token")
	rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (no bearer is expected in this mode)", rec.Code)
	}
	if len(recorded.all()) != 1 {
		t.Fatalf("upstream called %d times, want 1", len(recorded.all()))
	}
	if got := recorded.all()[0].Header.Get("Authorization"); got != "Bearer kubeconfig-token" {
		t.Errorf("upstream Authorization = %q, want the kubeconfig's own credentials", got)
	}
}

// Regression for the Header.Del in rewriteFor: client-go's bearer round tripper
// declines to overwrite an Authorization header that is already set, so without
// the strip a client-supplied token would reach the apiserver *instead of* the
// kubeconfig's credentials — letting the browser pick the identity.
func TestGatewayConfigCredentialsOverrideInboundBearer(t *testing.T) {
	gw, recorded := newCredentialedGateway(t, "kubeconfig-token")
	h := http.Header{}
	h.Set("Authorization", "Bearer SENTINEL-client-chosen-token")
	rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods", h, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if len(recorded.all()) != 1 {
		t.Fatalf("upstream called %d times, want 1", len(recorded.all()))
	}
	got := recorded.all()[0].Header.Get("Authorization")
	if strings.Contains(got, "SENTINEL-client-chosen-token") {
		t.Fatalf("client-supplied token reached the apiserver: %q", got)
	}
	if got != "Bearer kubeconfig-token" {
		t.Errorf("upstream Authorization = %q, want the kubeconfig's own credentials", got)
	}
}
