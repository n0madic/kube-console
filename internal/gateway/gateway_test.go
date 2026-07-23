package gateway

import (
	"bufio"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

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

func newTestGateway(t *testing.T, upstream http.HandlerFunc) (*Gateway, *[]recordedRequest, *httptest.Server) {
	t.Helper()
	var recorded []recordedRequest
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		recorded = append(recorded, recordedRequest{
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
	return New(reg, slog.New(slog.DiscardHandler)), &recorded, ts
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
	if len(*recorded) != 0 {
		t.Fatalf("upstream was called %d times for blocked paths", len(*recorded))
	}
}

func TestGatewayLogSubresourcePasses(t *testing.T) {
	gw, recorded, _ := newTestGateway(t, nil)
	rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/namespaces/ns/pods/p/log?tailLines=100", bearerHeader(), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if len(*recorded) != 1 {
		t.Fatalf("upstream called %d times, want 1", len(*recorded))
	}
	got := (*recorded)[0]
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
		{"plain list", "/k8s/api/v1/pods", false},
		{"log follow", "/k8s/api/v1/namespaces/ns/pods/p/log?follow=true", true},
		{"log without follow", "/k8s/api/v1/namespaces/ns/pods/p/log?tailLines=100", false},
		{"follow on non-log path", "/k8s/api/v1/namespaces/ns/pods/p?follow=true", false},
		{"malformed watch value", "/k8s/api/v1/pods?watch=maybe", false},
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
	got := (*recorded)[0]
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
	if len(*recorded) != 0 {
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
	if len(*recorded) != 0 {
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
	if len(*recorded) != 0 {
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
	gw, recorded, _ := newTestGateway(t, nil)
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
	for _, rr := range *recorded {
		if len(rr.Body) > 16 {
			t.Fatal("oversized body must not fully reach upstream")
		}
	}
}

// newMultiContextGateway wires two recording upstreams (alpha default + beta)
// so context routing and header stripping can be asserted.
func newMultiContextGateway(t *testing.T) (*Gateway, *[]recordedRequest, *[]recordedRequest) {
	t.Helper()
	newUpstream := func() (*kube.Upstream, *[]recordedRequest) {
		var recorded []recordedRequest
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			recorded = append(recorded, recordedRequest{
				Method: r.Method,
				Path:   r.URL.Path,
				Header: r.Header.Clone(),
			})
			w.WriteHeader(http.StatusOK)
		}))
		t.Cleanup(ts.Close)
		base, _ := url.Parse(ts.URL)
		return &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport}, &recorded
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
	if len(*alphaRec) != 1 || len(*betaRec) != 0 {
		t.Fatalf("default routing: alpha=%d beta=%d, want alpha", len(*alphaRec), len(*betaRec))
	}

	// Explicit beta header → beta upstream.
	h := bearerHeader()
	h.Set("X-Kube-Context", "beta")
	if rec := doGateway(gw, http.MethodGet, "/k8s/api/v1/pods", h, nil); rec.Code != http.StatusOK {
		t.Fatalf("beta route status = %d", rec.Code)
	}
	if len(*alphaRec) != 1 || len(*betaRec) != 1 {
		t.Fatalf("beta routing: alpha=%d beta=%d, want beta", len(*alphaRec), len(*betaRec))
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
	if len(*alphaRec) != 0 || len(*betaRec) != 0 {
		t.Fatalf("unknown context reached an upstream: alpha=%d beta=%d", len(*alphaRec), len(*betaRec))
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
	if len(*betaRec) != 1 {
		t.Fatalf("beta upstream calls = %d, want 1", len(*betaRec))
	}
	if leaked := (*betaRec)[0].Header.Get("X-Kube-Context"); leaked != "" {
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
