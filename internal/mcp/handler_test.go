package mcp

import (
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

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/kube"
)

const sentinelToken = "sentinel-token-7c1e4b"

// seen records what the fake apiserver received.
type seen struct {
	mu     sync.Mutex
	auth   []string
	agents []string
	hits   int
}

func (s *seen) record(r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hits++
	s.auth = append(s.auth, r.Header.Get("Authorization"))
	s.agents = append(s.agents, r.Header.Get("User-Agent"))
}

func (s *seen) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hits
}

// fakeAPIServer answers SelfSubjectReview with a fixed identity, or with
// status when it is non-zero.
func fakeAPIServer(t *testing.T, rec *seen, status int) *kube.Upstream {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.record(r)
		if status != 0 {
			w.WriteHeader(status)
			_, _ = io.WriteString(w, `{"kind":"Status","message":"boom `+r.Header.Get("Authorization")+`"}`)
			return
		}
		if r.URL.Path != "/apis/authentication.k8s.io/v1/selfsubjectreviews" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"apiVersion":"authentication.k8s.io/v1","kind":"SelfSubjectReview",`+
			`"status":{"userInfo":{"username":"system:serviceaccount:ops:agent","uid":"u-1","groups":["system:authenticated"]}}}`)
	}))
	t.Cleanup(ts.Close)
	base, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	return &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport}
}

type fixture struct {
	url    string
	logs   *bytes.Buffer
	logsMu *sync.Mutex
}

func (f fixture) logText() string {
	f.logsMu.Lock()
	defer f.logsMu.Unlock()
	return f.logs.String()
}

// lockedWriter keeps the debug log buffer safe under the server's goroutines.
type lockedWriter struct {
	mu  *sync.Mutex
	buf *bytes.Buffer
}

func (w lockedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func newFixture(t *testing.T, reg *kube.Registry) fixture {
	return newFixtureAt(t, reg, slog.LevelDebug)
}

func newFixtureAt(t *testing.T, reg *kube.Registry, level slog.Level) fixture {
	return newFixtureWith(t, reg, level, nil)
}

// newFixtureWith lets a test adjust the Options (e.g. attach a metrics
// adapter) before the handler is built.
func newFixtureWith(t *testing.T, reg *kube.Registry, level slog.Level, adjust func(*Options)) fixture {
	t.Helper()
	buf, mu := &bytes.Buffer{}, &sync.Mutex{}
	logger := slog.New(slog.NewTextHandler(lockedWriter{mu: mu, buf: buf}, &slog.HandlerOptions{Level: level}))
	o := Options{Registry: reg, Mode: config.MCPRead, Version: "test", MaxBodyBytes: 1 << 20, Logger: logger}
	if adjust != nil {
		adjust(&o)
	}
	h := NewHandler(o)
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	return fixture{url: ts.URL, logs: buf, logsMu: mu}
}

func singleRegistry(up *kube.Upstream) *kube.Registry {
	return kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up})
}

const callWhoami = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{},` +
	`"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}`

// legacyWhoami is a pre-2026-07-28 call: no _meta, and sent with
// legacyHeaders, i.e. none of the 2026-07-28 request headers.
const legacyWhoami = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}`

var legacyHeaders = map[string]string{"MCP-Protocol-Version": "", "Mcp-Method": "", "Mcp-Name": ""}

// post sends one raw JSON-RPC message with the 2026-07-28 headers, which the
// caller may override or delete through hdr (an empty value deletes).
func post(t *testing.T, endpoint, body string, hdr map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", ProtocolVersion)
	req.Header.Set("Mcp-Method", "tools/call")
	req.Header.Set("Mcp-Name", "whoami")
	req.Header.Set("Authorization", "Bearer "+sentinelToken)
	for k, v := range hdr {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRawWhoamiCall(t *testing.T) {
	rec := &seen{}
	f := newFixture(t, singleRegistry(fakeAPIServer(t, rec, 0)))
	resp := post(t, f.url, callWhoami, nil)
	body := readBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body %s", resp.StatusCode, body)
	}
	if !strings.Contains(body, "system:serviceaccount:ops:agent") {
		t.Errorf("identity missing from %s", body)
	}
	// The request's own bearer goes upstream, and the agent is named in the
	// User-Agent so the apiserver audit log can tell it from the SPA.
	if rec.count() != 1 || rec.auth[0] != "Bearer "+sentinelToken {
		t.Errorf("upstream auth = %v, want the caller's bearer once", rec.auth)
	}
	if rec.agents[0] != "kube-console-mcp/test" {
		t.Errorf("upstream User-Agent = %q", rec.agents[0])
	}
}

func TestGuardRejectsBeforeUpstream(t *testing.T) {
	cases := []struct {
		name   string
		method string
		hdr    map[string]string
		want   int
	}{
		// A browser always sends Origin on a POST: DNS rebinding, a page
		// targeting a developer's local port, any cross-site form.
		{"origin", http.MethodPost, map[string]string{"Origin": "https://evil.example"}, http.StatusForbidden},
		// Even our own origin: nothing in the SPA talks to /mcp.
		{"same origin", http.MethodPost, map[string]string{"Origin": "http://127.0.0.1"}, http.StatusForbidden},
		{"no token", http.MethodPost, map[string]string{"Authorization": ""}, http.StatusUnauthorized},
		{"basic auth", http.MethodPost, map[string]string{"Authorization": "Basic dXNlcjpwYXNz"}, http.StatusUnauthorized},
		{"unknown context", http.MethodPost, map[string]string{kube.ContextHeader: "nope"}, http.StatusBadRequest},
		// No GET stream and no session to DELETE in 2026-07-28.
		{"get", http.MethodGet, map[string]string{"Authorization": ""}, http.StatusMethodNotAllowed},
		{"delete", http.MethodDelete, nil, http.StatusMethodNotAllowed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := &seen{}
			f := newFixture(t, singleRegistry(fakeAPIServer(t, rec, 0)))
			var resp *http.Response
			if tc.method == http.MethodPost {
				resp = post(t, f.url, callWhoami, tc.hdr)
			} else {
				req, _ := http.NewRequest(tc.method, f.url, nil)
				for k, v := range tc.hdr {
					if v != "" {
						req.Header.Set(k, v)
					}
				}
				var err error
				if resp, err = http.DefaultClient.Do(req); err != nil {
					t.Fatal(err)
				}
				defer func() { _ = resp.Body.Close() }()
			}
			if resp.StatusCode != tc.want {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.want)
			}
			if rec.count() != 0 {
				t.Errorf("upstream contacted %d times for a rejected request", rec.count())
			}
			if tc.want == http.StatusUnauthorized && resp.Header.Get("WWW-Authenticate") == "" {
				t.Error("401 without WWW-Authenticate")
			}
			if tc.want == http.StatusMethodNotAllowed && resp.Header.Get("Allow") != http.MethodPost {
				t.Errorf("Allow = %q, want POST", resp.Header.Get("Allow"))
			}
		})
	}
}

func TestProtocolRevisionEnforced(t *testing.T) {
	cases := []struct {
		name string
		body string
		hdr  map[string]string
	}{
		// Legacy revisions need a session this endpoint does not keep.
		{"legacy version", strings.ReplaceAll(callWhoami, ProtocolVersion, "2025-11-25"),
			map[string]string{"MCP-Protocol-Version": "2025-11-25"}},
		// The header is mandatory in 2026-07-28; its absence must not fall back
		// to an older revision.
		{"no version header", callWhoami, map[string]string{"MCP-Protocol-Version": ""}},
		// Routing headers must agree with the body.
		{"header mismatch", callWhoami, map[string]string{"Mcp-Name": "something-else"}},
		// The body must be a single message: a batch would put several calls
		// behind one in-flight slot.
		{"batch", "[" + callWhoami + "]", nil},
		{"batch without version", "[" + callWhoami + "]", map[string]string{"MCP-Protocol-Version": ""}},
		// The legacy shape: no _meta and no version header, which the SDK
		// would otherwise read as 2025-03-26 — a revision that still allowed
		// batches. Neither a batch nor a single call of that shape may run.
		{"legacy batch", "[" + legacyWhoami + "," + legacyWhoami + "]", legacyHeaders},
		{"legacy call", legacyWhoami, legacyHeaders},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := &seen{}
			f := newFixture(t, singleRegistry(fakeAPIServer(t, rec, 0)))
			resp := post(t, f.url, tc.body, tc.hdr)
			body := readBody(t, resp)
			t.Logf("status %d: %s", resp.StatusCode, strings.TrimSpace(body))
			if resp.StatusCode < 400 || resp.StatusCode >= 500 {
				t.Errorf("status = %d, want a 4xx; body %s", resp.StatusCode, body)
			}
			if rec.count() != 0 {
				t.Errorf("upstream contacted for a rejected request: %s", body)
			}
		})
	}
}

// headerTransport stamps fixed headers on every client request, the way an MCP
// client configured with --header does.
type headerTransport struct {
	hdr  map[string]string
	base http.RoundTripper
}

func (h headerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	c := r.Clone(r.Context())
	for k, v := range h.hdr {
		c.Header.Set(k, v)
	}
	return h.base.RoundTrip(c)
}

func connect(t *testing.T, endpoint string, hdr map[string]string) *sdk.ClientSession {
	t.Helper()
	client := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "0"}, nil)
	cs, err := client.Connect(context.Background(), &sdk.StreamableClientTransport{
		Endpoint:   endpoint,
		HTTPClient: &http.Client{Transport: headerTransport{hdr: hdr, base: http.DefaultTransport}},
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

func TestSDKClientWhoamiOnSelectedContext(t *testing.T) {
	alphaRec, betaRec := &seen{}, &seen{}
	reg := kube.NewRegistryFromUpstreams("alpha", map[string]*kube.Upstream{
		"alpha": fakeAPIServer(t, alphaRec, 0),
		"beta":  fakeAPIServer(t, betaRec, 0),
	})
	f := newFixture(t, reg)
	cs := connect(t, f.url, map[string]string{
		"Authorization":    "Bearer " + sentinelToken,
		kube.ContextHeader: "beta",
	})
	if v := cs.InitializeResult().ProtocolVersion; v != ProtocolVersion {
		t.Errorf("negotiated %q, want %q", v, ProtocolVersion)
	}

	tools, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
		// Read mode registers read-only tools and nothing else.
		if a := tool.Annotations; a == nil || !a.ReadOnlyHint || a.DestructiveHint != nil {
			t.Errorf("%s must be annotated read-only, got %+v", tool.Name, a)
		}
	}
	slices.Sort(names)
	// No metrics adapter in this fixture, so no top tool either.
	want := []string{"get_pod_logs", "get_resource", "list_api_resources", "list_events", "list_resources", "whoami"}
	if !slices.Equal(names, want) {
		t.Fatalf("tools = %v, want %v", names, want)
	}

	res, err := cs.CallTool(context.Background(), &sdk.CallToolParams{Name: "whoami", Arguments: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if res.IsError {
		t.Fatalf("whoami failed: %+v", res.Content)
	}
	var out whoamiOut
	raw, _ := json.Marshal(res.StructuredContent)
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if out.Context != "beta" || out.Username != "system:serviceaccount:ops:agent" {
		t.Errorf("whoami = %+v", out)
	}
	// The context header picked the upstream; the default was never asked.
	if alphaRec.count() != 0 || betaRec.count() == 0 {
		t.Errorf("alpha hits %d, beta hits %d", alphaRec.count(), betaRec.count())
	}
}

func TestKubeconfigModeNeedsNoToken(t *testing.T) {
	rec := &seen{}
	up := fakeAPIServer(t, rec, 0)
	up.UseConfigCredentials = true
	f := newFixture(t, singleRegistry(up))
	resp := post(t, f.url, callWhoami, map[string]string{"Authorization": ""})
	body := readBody(t, resp)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, "system:serviceaccount:ops:agent") {
		t.Fatalf("status = %d, body %s", resp.StatusCode, body)
	}
	// The upstream transport authenticates by itself; no bearer is attached.
	if rec.auth[0] != "" {
		t.Errorf("upstream Authorization = %q, want none in kubeconfig mode", rec.auth[0])
	}
}

func TestToolErrorsLeakNothing(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusInternalServerError} {
		rec := &seen{}
		up := fakeAPIServer(t, rec, status)
		f := newFixture(t, singleRegistry(up))
		resp := post(t, f.url, callWhoami, nil)
		body := readBody(t, resp)
		if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"isError":true`) {
			t.Fatalf("status %d: want an isError tool result, got %d %s", status, resp.StatusCode, body)
		}
		// The fake apiserver echoes the Authorization header into its error
		// body; neither it nor the upstream address may reach the client.
		for _, secret := range []string{sentinelToken, up.BaseURL.Host} {
			if strings.Contains(body, secret) {
				t.Errorf("status %d: response leaks %q: %s", status, secret, body)
			}
			if strings.Contains(f.logText(), secret) {
				t.Errorf("status %d: debug log leaks %q", status, secret)
			}
		}
	}
}

func TestToolCallIsLogged(t *testing.T) {
	f := newFixture(t, singleRegistry(fakeAPIServer(t, &seen{}, 0)))
	readBody(t, post(t, f.url, callWhoami, nil))
	logs := f.logText()
	if !strings.Contains(logs, "mcp tool") || !strings.Contains(logs, "tool=whoami") || !strings.Contains(logs, "outcome=ok") {
		t.Errorf("missing call log line:\n%s", logs)
	}
	if strings.Contains(logs, sentinelToken) {
		t.Error("token in logs")
	}
}

// At Info a call is the one "mcp tool" line: the SDK narrates every stateless
// request (connecting, session connected, disconnected), which is demoted.
func TestSDKChatterDemotedBelowInfo(t *testing.T) {
	f := newFixtureAt(t, singleRegistry(fakeAPIServer(t, &seen{}, 0)), slog.LevelInfo)
	readBody(t, post(t, f.url, callWhoami, nil))
	logs := f.logText()
	if !strings.Contains(logs, "tool=whoami") {
		t.Fatalf("missing call log line:\n%s", logs)
	}
	if strings.Contains(logs, "component=mcp") {
		t.Errorf("SDK lifecycle chatter at Info:\n%s", logs)
	}
}
