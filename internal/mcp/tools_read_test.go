package mcp

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/n0madic/kube-console/internal/kube"
)

// apiRequest is what the fake apiserver saw.
type apiRequest struct {
	method      string
	path        string
	query       url.Values
	accept      string
	contentType string
	body        string
}

// fakeCluster is a fake apiserver whose responses are keyed by path.
type fakeCluster struct {
	mu       sync.Mutex
	requests []apiRequest
	routes   map[string]func(w http.ResponseWriter, r *http.Request)
}

func (f *fakeCluster) last(t *testing.T) apiRequest {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requests) == 0 {
		t.Fatal("the apiserver was never contacted")
	}
	return f.requests[len(f.requests)-1]
}

func (f *fakeCluster) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func jsonRoute(status int, body string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

// newCluster serves routes and connects an SDK client to an MCP endpoint in
// front of it, as an agent would.
func newCluster(t *testing.T, routes map[string]func(http.ResponseWriter, *http.Request)) (*fakeCluster, *sdk.ClientSession) {
	t.Helper()
	return newClusterWith(t, routes, nil)
}

// newClusterWith is newCluster with the handler Options adjusted; the
// registry passed to adjust is the one fronting the fake apiserver.
func newClusterWith(t *testing.T, routes map[string]func(http.ResponseWriter, *http.Request), adjust func(*Options)) (*fakeCluster, *sdk.ClientSession) {
	t.Helper()
	f, cs, _ := startCluster(t, routes, adjust)
	return f, cs
}

// startCluster is newClusterWith that also hands back the fixture, for tests
// that read the handler's log.
func startCluster(t *testing.T, routes map[string]func(http.ResponseWriter, *http.Request), adjust func(*Options)) (*fakeCluster, *sdk.ClientSession, fixture) {
	t.Helper()
	f := &fakeCluster{routes: routes}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.requests = append(f.requests, apiRequest{
			method:      r.Method,
			path:        r.URL.EscapedPath(),
			query:       r.URL.Query(),
			accept:      r.Header.Get("Accept"),
			contentType: r.Header.Get("Content-Type"),
			body:        string(body),
		})
		f.mu.Unlock()
		if h, ok := f.routes[r.URL.EscapedPath()]; ok {
			h(w, r)
			return
		}
		jsonRoute(http.StatusNotFound, `{"kind":"Status","reason":"NotFound","message":"the server could not find the requested resource"}`)(w, r)
	}))
	t.Cleanup(ts.Close)
	base, _ := url.Parse(ts.URL)
	reg := singleRegistry(&kube.Upstream{BaseURL: base, Transport: http.DefaultTransport})
	fx := newFixtureWith(t, reg, slog.LevelDebug, adjust)
	return f, connect(t, fx.url, map[string]string{"Authorization": "Bearer " + sentinelToken}), fx
}

func call(t *testing.T, cs *sdk.ClientSession, name string, args map[string]any) *sdk.CallToolResult {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return res
}

func text(res *sdk.CallToolResult) string {
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*sdk.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}

func structured[T any](t *testing.T, res *sdk.CallToolResult) T {
	t.Helper()
	if res.IsError {
		t.Fatalf("tool error: %s", text(res))
	}
	var out T
	raw, _ := json.Marshal(res.StructuredContent)
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

const podTable = `{"kind":"Table","apiVersion":"meta.k8s.io/v1",
	"metadata":{"continue":"next-page","remainingItemCount":7},
	"columnDefinitions":[{"name":"Name","priority":0},{"name":"Ready","priority":0},{"name":"IP","priority":1}],
	"rows":[
		{"cells":["web-0","1/1","10.0.0.1"],"object":{"metadata":{"name":"web-0","namespace":"shop","managedFields":[{"manager":"x"}]}}},
		{"cells":["db-0","0/1","10.0.0.2"],"object":{"metadata":{"name":"db-0","namespace":"data"}}}]}`

func TestListResourcesTable(t *testing.T) {
	f, cs := newCluster(t, map[string]func(http.ResponseWriter, *http.Request){
		"/api/v1/pods": jsonRoute(http.StatusOK, podTable),
	})
	out := structured[listResourcesOut](t, call(t, cs, "list_resources", map[string]any{
		"apiVersion": "v1", "resource": "pods", "labelSelector": "app=web,tier!=cache", "continue": "tok",
	}))
	// Priority-0 columns only, as kubectl prints them without -o wide.
	if strings.Join(out.Columns, ",") != "Name,Ready" {
		t.Errorf("columns = %v", out.Columns)
	}
	if len(out.Rows) != 2 || out.Rows[0].Namespace != "shop" || out.Rows[0].Name != "web-0" {
		t.Fatalf("rows = %+v", out.Rows)
	}
	if len(out.Rows[1].Cells) != 2 || out.Rows[1].Cells[1] != "0/1" {
		t.Errorf("cells = %v", out.Rows[1].Cells)
	}
	if out.Continue != "next-page" || out.RemainingItemCount == nil || *out.RemainingItemCount != 7 {
		t.Errorf("paging = %q %v", out.Continue, out.RemainingItemCount)
	}
	req := f.last(t)
	if !strings.Contains(req.accept, "as=Table") {
		t.Errorf("Accept = %q, want the Table projection", req.accept)
	}
	for k, want := range map[string]string{"limit": "100", "includeObject": "Metadata", "labelSelector": "app=web,tier!=cache", "continue": "tok"} {
		if got := req.query.Get(k); got != want {
			t.Errorf("query %s = %q, want %q", k, got, want)
		}
	}
}

func TestListResourcesLimitAndFallback(t *testing.T) {
	f, cs := newCluster(t, map[string]func(http.ResponseWriter, *http.Request){
		"/apis/example.com/v1/namespaces/ns/widgets": jsonRoute(http.StatusOK,
			`{"kind":"WidgetList","items":[{"metadata":{"name":"w1","namespace":"ns","creationTimestamp":"2026-01-02T03:04:05Z"}}]}`),
	})
	out := structured[listResourcesOut](t, call(t, cs, "list_resources", map[string]any{
		"apiVersion": "example.com/v1", "resource": "widgets", "namespace": "ns", "limit": 100000,
	}))
	if got := f.last(t).query.Get("limit"); got != "500" {
		t.Errorf("limit = %s, want the 500 cap", got)
	}
	// An API without Table support still lists, by name and creation time.
	if strings.Join(out.Columns, ",") != "Name,Created" || len(out.Rows) != 1 || out.Rows[0].Name != "w1" {
		t.Errorf("fallback = %+v", out)
	}
}

// A Table page is read up to 16 MiB but a result lands in a model's context,
// so a projection past the 1 MiB output bound is an error asking for a smaller
// page, never a multi-MiB result. Printer cells are the server's (or a CRD's
// additionalPrinterColumns') choice, so their size is not ours to assume.
func TestListResourcesResultBounded(t *testing.T) {
	cell := strings.Repeat("x", 4096)
	var rows []string
	for i := range 400 {
		rows = append(rows, `{"cells":["w`+strconv.Itoa(i)+`","`+cell+`"],"object":{"metadata":{"name":"w`+strconv.Itoa(i)+`","namespace":"ns"}}}`)
	}
	table := `{"kind":"Table","columnDefinitions":[{"name":"Name","priority":0},{"name":"Spec","priority":0}],"rows":[` +
		strings.Join(rows, ",") + `]}`
	_, cs := newCluster(t, map[string]func(http.ResponseWriter, *http.Request){
		"/apis/example.com/v1/widgets": jsonRoute(http.StatusOK, table),
	})
	res := call(t, cs, "list_resources", map[string]any{"apiVersion": "example.com/v1", "resource": "widgets", "limit": 400})
	if !res.IsError || !strings.Contains(text(res), "limit") {
		t.Errorf("want a size error naming the limit, got IsError=%v, %d bytes", res.IsError, len(text(res)))
	}
}

func TestReadToolsRejectBadArgumentsBeforeUpstream(t *testing.T) {
	f, cs := newCluster(t, nil)
	cases := []struct {
		tool string
		args map[string]any
	}{
		{"list_resources", map[string]any{"apiVersion": "v1", "resource": "pods/exec"}},
		{"list_resources", map[string]any{"apiVersion": "../v1", "resource": "pods"}},
		{"list_resources", map[string]any{"apiVersion": "v1", "resource": "pods", "namespace": "a/b"}},
		{"list_resources", map[string]any{"apiVersion": "v1", "resource": "pods", "labelSelector": strings.Repeat("a", 5000)}},
		{"get_resource", map[string]any{"apiVersion": "v1", "resource": "pods", "namespace": "ns", "name": "../x"}},
		{"get_resource", map[string]any{"apiVersion": "v1", "resource": "pods", "namespace": "ns", "name": "exec"}},
		{"get_resource", map[string]any{"apiVersion": "v1", "resource": "pods", "namespace": "ns", "name": ""}},
		{"get_pod_logs", map[string]any{"namespace": "ns", "pod": "p", "container": "a/b"}},
		{"get_pod_logs", map[string]any{"namespace": "ns", "pod": ""}},
		{"list_events", map[string]any{"involvedKind": "Pod,x=y"}},
		// Missing required arguments fail schema validation in the SDK.
		{"list_resources", map[string]any{"resource": "pods"}},
	}
	for _, tc := range cases {
		if res := call(t, cs, tc.tool, tc.args); !res.IsError {
			t.Errorf("%s %v: want a tool error, got %s", tc.tool, tc.args, text(res))
		}
	}
	if f.count() != 0 {
		t.Errorf("apiserver contacted %d times for invalid arguments", f.count())
	}
}

func TestUpstreamStatusReachesTheAgent(t *testing.T) {
	_, cs := newCluster(t, map[string]func(http.ResponseWriter, *http.Request){
		"/api/v1/namespaces/ns/secrets": jsonRoute(http.StatusForbidden,
			`{"kind":"Status","reason":"Forbidden","message":"secrets is forbidden: User \"agent\" cannot list resource \"secrets\" (token `+sentinelToken+`)"}`),
	})
	res := call(t, cs, "list_resources", map[string]any{"apiVersion": "v1", "resource": "secrets", "namespace": "ns"})
	msg := text(res)
	if !res.IsError || !strings.Contains(msg, "403 Forbidden: secrets is forbidden") {
		t.Errorf("want the apiserver's own denial, got %q", msg)
	}
	// Scrubbed even when something upstream echoes it.
	if strings.Contains(msg, sentinelToken) {
		t.Errorf("token leaked into the tool error: %q", msg)
	}
}

// The reason is upstream text too: a proxy in front of the apiserver is not
// held to the apiserver's rules about what it puts there.
func TestUpstreamReasonIsScrubbed(t *testing.T) {
	_, cs := newCluster(t, map[string]func(http.ResponseWriter, *http.Request){
		"/api/v1/pods": jsonRoute(http.StatusUnauthorized,
			`{"kind":"Status","reason":"rejected bearer `+sentinelToken+`","message":"Unauthorized"}`),
	})
	res := call(t, cs, "list_resources", map[string]any{"apiVersion": "v1", "resource": "pods"})
	if msg := text(res); !res.IsError || strings.Contains(msg, sentinelToken) || !strings.Contains(msg, "401") {
		t.Errorf("want a scrubbed 401, got %q", msg)
	}
}

func TestGetResourceRedactsSecret(t *testing.T) {
	f, cs := newCluster(t, map[string]func(http.ResponseWriter, *http.Request){
		"/api/v1/namespaces/ns/secrets/db": jsonRoute(http.StatusOK,
			`{"apiVersion":"v1","kind":"Secret","metadata":{"name":"db","namespace":"ns","managedFields":[{}]},`+
				`"data":{"password":"aHVudGVyMg=="},"type":"Opaque"}`),
	})
	res := call(t, cs, "get_resource", map[string]any{"apiVersion": "v1", "resource": "secrets", "namespace": "ns", "name": "db"})
	if res.IsError {
		t.Fatal(text(res))
	}
	y := text(res)
	if strings.Contains(y, "aHVudGVyMg==") || strings.Contains(y, "managedFields") {
		t.Errorf("unredacted YAML:\n%s", y)
	}
	if !strings.Contains(y, "password: '<redacted: 7 bytes>'") || !strings.Contains(y, "kind: Secret") {
		t.Errorf("YAML = \n%s", y)
	}
	if f.last(t).accept != "application/json" {
		t.Errorf("Accept = %q", f.last(t).accept)
	}
}

func TestGetResourceTooLarge(t *testing.T) {
	big := `{"apiVersion":"v1","kind":"ConfigMap","data":{"k":"` + strings.Repeat("x", readObjectBytes) + `"}}`
	_, cs := newCluster(t, map[string]func(http.ResponseWriter, *http.Request){
		"/api/v1/namespaces/ns/configmaps/big": jsonRoute(http.StatusOK, big),
	})
	res := call(t, cs, "get_resource", map[string]any{"apiVersion": "v1", "resource": "configmaps", "namespace": "ns", "name": "big"})
	if !res.IsError || !strings.Contains(text(res), "exceeds") {
		t.Errorf("want a size error, got %.200s", text(res))
	}
}

func TestGetPodLogs(t *testing.T) {
	logBody := "line 1\nline 2\n"
	f, cs := newCluster(t, map[string]func(http.ResponseWriter, *http.Request){
		"/api/v1/namespaces/ns/pods/web-0/log": func(w http.ResponseWriter, r *http.Request) {
			// Like a real apiserver: the log stream is text/plain, but Accept
			// is negotiated against the registered serializers, and an
			// explicit text/plain is refused with 406.
			if accept := r.Header.Get("Accept"); accept != "" && !strings.Contains(accept, "*/*") {
				jsonRoute(http.StatusNotAcceptable, `{"kind":"Status","reason":"NotAcceptable","message":"only the following media types are accepted: application/json, application/yaml, application/vnd.kubernetes.protobuf"}`)(w, r)
				return
			}
			_, _ = io.WriteString(w, logBody)
		},
	})
	res := call(t, cs, "get_pod_logs", map[string]any{"namespace": "ns", "pod": "web-0", "container": "app", "previous": true})
	if res.IsError || text(res) != logBody {
		t.Fatalf("logs = %q", text(res))
	}
	q := f.last(t).query
	for k, want := range map[string]string{"tailLines": "200", "limitBytes": "262144", "container": "app", "previous": "true", "follow": ""} {
		if got := q.Get(k); got != want {
			t.Errorf("query %s = %q, want %q", k, got, want)
		}
	}

	call(t, cs, "get_pod_logs", map[string]any{"namespace": "ns", "pod": "web-0", "tailLines": 99999})
	if got := f.last(t).query.Get("tailLines"); got != "2000" {
		t.Errorf("tailLines = %s, want the 2000 cap", got)
	}

	// A body that reaches limitBytes was cut by the kubelet: say so.
	logBody = strings.Repeat("x", logLimitBytes)
	if got := text(call(t, cs, "get_pod_logs", map[string]any{"namespace": "ns", "pod": "web-0"})); !strings.HasSuffix(got, "sinceSeconds]") {
		t.Errorf("missing truncation notice: %q", got[len(got)-80:])
	}

	// The kubelet cuts at limitBytes wherever that falls — mid-line, mid-rune —
	// and it is the newest lines that are lost (it writes forward from the
	// start of the tail window). The result keeps whole lines only and says
	// which end is missing.
	// 14 bytes a line, and 262144 = 14*18724 + 8: the cut lands inside "б".
	logBody = strings.Repeat("aошибка\n", logLimitBytes/14+1)
	got := text(call(t, cs, "get_pod_logs", map[string]any{"namespace": "ns", "pod": "web-0"}))
	logs, notice, ok := strings.Cut(got, "\n[truncated")
	if !ok || !strings.Contains(notice, "newest") {
		t.Fatalf("notice = %q, want it to say the newest lines are missing", notice)
	}
	if !utf8.ValidString(logs) || !strings.HasSuffix(logs, "\naошибка") {
		t.Errorf("truncated log ends %q, want the last whole line", logs[max(0, len(logs)-20):])
	}

	logBody = ""
	if got := text(call(t, cs, "get_pod_logs", map[string]any{"namespace": "ns", "pod": "web-0"})); got != "(no log lines)" {
		t.Errorf("empty log = %q", got)
	}
}

func TestListEvents(t *testing.T) {
	f, cs := newCluster(t, map[string]func(http.ResponseWriter, *http.Request){
		"/api/v1/namespaces/ns/events": jsonRoute(http.StatusOK, `{"metadata":{"continue":"more"},"items":[
			{"metadata":{"namespace":"ns","creationTimestamp":"2026-01-01T00:00:00Z"},"type":"Normal","reason":"Old",
			 "lastTimestamp":"2026-01-01T10:00:00Z","involvedObject":{"kind":"Pod","name":"a,b=c","namespace":"ns"}},
			{"metadata":{"namespace":"ns"},"type":"Warning","reason":"Newest","count":3,"message":"Back-off restarting",
			 "eventTime":"2026-01-01T10:00:00.500000Z","involvedObject":{"kind":"Pod","name":"a,b=c"}},
			{"metadata":{"namespace":"ns"},"type":"Normal","reason":"Middle",
			 "lastTimestamp":"2026-01-01T10:00:00Z","involvedObject":{"kind":"Pod","name":"a,b=c"}}]}`),
	})
	out := structured[listEventsOut](t, call(t, cs, "list_events", map[string]any{
		"namespace": "ns", "involvedKind": "Pod", "involvedName": "a,b=c", "limit": 2,
	}))
	// Newest first by parsed time: eventTime's sub-second precision beats a
	// whole-second lastTimestamp, which string order would get wrong.
	if len(out.Events) != 2 || out.Events[0].Reason != "Newest" {
		t.Fatalf("events = %+v", out.Events)
	}
	if out.Events[0].Object != "Pod/a,b=c" || out.Events[0].Count != 3 || out.Events[0].Namespace != "ns" {
		t.Errorf("event = %+v", out.Events[0])
	}
	if !out.Truncated {
		t.Error("a continue token means more events matched than were scanned")
	}
	// The name's own ',' and '=' are escaped so they cannot add selector terms.
	if got := f.last(t).query.Get("fieldSelector"); got != `involvedObject.kind=Pod,involvedObject.name=a\,b\=c` {
		t.Errorf("fieldSelector = %q", got)
	}
}

func TestListAPIResources(t *testing.T) {
	_, cs := newCluster(t, map[string]func(http.ResponseWriter, *http.Request){
		// Aggregated discovery is refused, so the legacy endpoints answer.
		"/api": func(w http.ResponseWriter, r *http.Request) {
			if strings.Contains(r.Header.Get("Accept"), "APIGroupDiscoveryList") {
				w.WriteHeader(http.StatusNotAcceptable)
				return
			}
			jsonRoute(http.StatusOK, `{"versions":["v1"]}`)(w, r)
		},
		"/apis": func(w http.ResponseWriter, r *http.Request) {
			if strings.Contains(r.Header.Get("Accept"), "APIGroupDiscoveryList") {
				w.WriteHeader(http.StatusNotAcceptable)
				return
			}
			jsonRoute(http.StatusOK, `{"groups":[{"name":"apps","versions":[{"groupVersion":"apps/v1","version":"v1"}]}]}`)(w, r)
		},
		"/api/v1": jsonRoute(http.StatusOK, `{"groupVersion":"v1","resources":[
			{"name":"pods","namespaced":true,"kind":"Pod","verbs":["get","list"],"shortNames":["po"]},
			{"name":"pods/log","namespaced":true,"kind":"Pod","verbs":["get"]}]}`),
		"/apis/apps/v1": jsonRoute(http.StatusOK, `{"groupVersion":"apps/v1","resources":[
			{"name":"deployments","namespaced":true,"kind":"Deployment","verbs":["get","list","patch"]}]}`),
	})
	out := structured[listAPIResourcesOut](t, call(t, cs, "list_api_resources", map[string]any{}))
	got := map[string]apiResource{}
	for _, r := range out.Resources {
		got[r.APIVersion+"/"+r.Resource] = r
	}
	if len(got) != 2 || got["v1/pods"].Kind != "Pod" || got["apps/v1/deployments"].Kind != "Deployment" {
		t.Fatalf("resources = %+v", out.Resources)
	}
	// The apiVersion is spelled exactly as the other tools take it.
	core := structured[listAPIResourcesOut](t, call(t, cs, "list_api_resources", map[string]any{"group": "core"}))
	if len(core.Resources) != 1 || core.Resources[0].APIVersion != "v1" {
		t.Errorf("core filter = %+v", core.Resources)
	}
}
