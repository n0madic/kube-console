package mcp

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/n0madic/kube-console/internal/metrics"
)

const metricsGroup = `{"kind":"APIGroup","name":"metrics.k8s.io",
	"versions":[{"groupVersion":"metrics.k8s.io/v1beta1","version":"v1beta1"}],
	"preferredVersion":{"groupVersion":"metrics.k8s.io/v1beta1","version":"v1beta1"}}`

const podMetricsList = `{"kind":"PodMetricsList","items":[
	{"metadata":{"name":"small","namespace":"shop"},"timestamp":"2026-11-17T10:00:00Z","window":"15s",
	 "containers":[{"name":"app","usage":{"cpu":"5m","memory":"10Mi"}}]},
	{"metadata":{"name":"hungry","namespace":"shop"},"timestamp":"2026-11-17T10:00:05Z","window":"15s",
	 "containers":[{"name":"app","usage":{"cpu":"20m","memory":"900Mi"}}]},
	{"metadata":{"name":"busy","namespace":"data"},"timestamp":"2026-11-17T10:00:01Z","window":"30s",
	 "containers":[{"name":"a","usage":{"cpu":"1","memory":"100Mi"}},{"name":"b","usage":{"cpu":"250m","memory":"28Mi"}}]}]}`

// withMetrics attaches a metrics adapter, as routes.go does when the adapter
// is enabled.
func withMetrics(o *Options) { o.Metrics = metrics.NewHandler(o.Registry, true) }

type topResult struct {
	ObservedAt    string    `json:"observedAt"`
	WindowSeconds int64     `json:"windowSeconds"`
	Total         int       `json:"total"`
	Items         []topItem `json:"items"`
}

func names(items []topItem) []string {
	var out []string
	for _, it := range items {
		out = append(out, it.Name)
	}
	return out
}

func TestTopPodsSortedAndLimited(t *testing.T) {
	f, cs := newClusterWith(t, map[string]func(http.ResponseWriter, *http.Request){
		"/apis/metrics.k8s.io":              jsonRoute(http.StatusOK, metricsGroup),
		"/apis/metrics.k8s.io/v1beta1/pods": jsonRoute(http.StatusOK, podMetricsList),
	}, withMetrics)

	out := structured[topResult](t, call(t, cs, "top", map[string]any{"kind": "pods"}))
	if got := names(out.Items); !slices.Equal(got, []string{"busy", "hungry", "small"}) {
		t.Errorf("default sort (cpu, descending) = %v", got)
	}
	busy := out.Items[0]
	if busy.Namespace != "data" || busy.CPUMillicores != 1250 || busy.MemoryMiB != 128 {
		t.Errorf("busy = %+v, want data/1250m/128Mi (containers summed)", busy)
	}
	if busy.Containers != nil {
		t.Errorf("containers are reported for a single pod only, got %+v", busy.Containers)
	}
	if out.Total != 3 || out.ObservedAt != "2026-11-17T10:00:05Z" || out.WindowSeconds != 30 {
		t.Errorf("total/observedAt/window = %d/%s/%d", out.Total, out.ObservedAt, out.WindowSeconds)
	}
	if p := f.last(t).path; p != "/apis/metrics.k8s.io/v1beta1/pods" {
		t.Errorf("all namespaces read %s", p)
	}

	out = structured[topResult](t, call(t, cs, "top", map[string]any{"kind": "pods", "sortBy": "memory", "limit": 1}))
	if got := names(out.Items); !slices.Equal(got, []string{"hungry"}) || out.Total != 3 {
		t.Errorf("memory, limit 1 = %v (total %d), want [hungry] of 3", got, out.Total)
	}
}

func TestTopNamespaceAndSinglePod(t *testing.T) {
	f, cs := newClusterWith(t, map[string]func(http.ResponseWriter, *http.Request){
		"/apis/metrics.k8s.io":                              jsonRoute(http.StatusOK, metricsGroup),
		"/apis/metrics.k8s.io/v1beta1/namespaces/data/pods": jsonRoute(http.StatusOK, `{"items":[]}`),
		"/apis/metrics.k8s.io/v1beta1/namespaces/data/pods/busy": jsonRoute(http.StatusOK,
			`{"metadata":{"name":"busy","namespace":"data"},"timestamp":"2026-11-17T10:00:01Z","window":"30s",
			  "containers":[{"name":"a","usage":{"cpu":"1","memory":"100Mi"}},{"name":"b","usage":{"cpu":"250m","memory":"28Mi"}}]}`),
	}, withMetrics)

	out := structured[topResult](t, call(t, cs, "top", map[string]any{"kind": "pods", "namespace": "data"}))
	if out.Items == nil || len(out.Items) != 0 {
		t.Errorf("an empty namespace is an empty list, got %+v", out.Items)
	}
	if p := f.last(t).path; p != "/apis/metrics.k8s.io/v1beta1/namespaces/data/pods" {
		t.Errorf("namespace read %s", p)
	}

	out = structured[topResult](t, call(t, cs, "top", map[string]any{"kind": "pods", "namespace": "data", "name": "busy"}))
	if len(out.Items) != 1 {
		t.Fatalf("items = %+v", out.Items)
	}
	got := out.Items[0].Containers
	want := []topContainer{{Name: "a", CPUMillicores: 1000, MemoryMiB: 100}, {Name: "b", CPUMillicores: 250, MemoryMiB: 28}}
	if !slices.Equal(got, want) {
		t.Errorf("containers = %+v, want %+v", got, want)
	}
}

func TestTopNodes(t *testing.T) {
	_, cs := newClusterWith(t, map[string]func(http.ResponseWriter, *http.Request){
		"/apis/metrics.k8s.io": jsonRoute(http.StatusOK, metricsGroup),
		"/apis/metrics.k8s.io/v1beta1/nodes": jsonRoute(http.StatusOK, `{"items":[
			{"metadata":{"name":"n1"},"timestamp":"2026-11-17T10:00:00Z","window":"20s","usage":{"cpu":"500m","memory":"2Gi"}},
			{"metadata":{"name":"n2"},"timestamp":"2026-11-17T10:00:00Z","window":"20s","usage":{"cpu":"1500m","memory":"1Gi"}}]}`),
	}, withMetrics)

	out := structured[topResult](t, call(t, cs, "top", map[string]any{"kind": "nodes"}))
	if got := names(out.Items); !slices.Equal(got, []string{"n2", "n1"}) {
		t.Errorf("nodes by cpu = %v", got)
	}
	if n := out.Items[1]; n.Namespace != "" || n.MemoryMiB != 2048 || n.CPUMillicores != 500 {
		t.Errorf("n1 = %+v", n)
	}
}

// A cluster without metrics-server is an ordinary answer an agent must be able
// to act on, not an opaque failure.
func TestTopMetricsNotInstalled(t *testing.T) {
	_, cs := newClusterWith(t, nil, withMetrics) // every path 404s, the group included
	res := call(t, cs, "top", map[string]any{"kind": "nodes"})
	if !res.IsError || !strings.Contains(text(res), "metrics.k8s.io is not installed") {
		t.Errorf("not installed = %v %q", res.IsError, text(res))
	}
}

// An upstream denial carries the apiserver's own message, with the caller's
// token scrubbed like every other upstream error.
func TestTopUpstreamStatus(t *testing.T) {
	_, cs := newClusterWith(t, map[string]func(http.ResponseWriter, *http.Request){
		"/apis/metrics.k8s.io": jsonRoute(http.StatusOK, metricsGroup),
		"/apis/metrics.k8s.io/v1beta1/pods": jsonRoute(http.StatusForbidden,
			`{"kind":"Status","reason":"Forbidden","message":"pods.metrics.k8s.io is forbidden: token `+sentinelToken+`"}`),
	}, withMetrics)
	res := call(t, cs, "top", map[string]any{"kind": "pods"})
	msg := text(res)
	if !res.IsError || !strings.Contains(msg, "403") || !strings.Contains(msg, "pods.metrics.k8s.io is forbidden") {
		t.Errorf("forbidden = %v %q", res.IsError, msg)
	}
	if strings.Contains(msg, sentinelToken) {
		t.Errorf("token leaked into the tool error: %q", msg)
	}
}

func TestTopRejectsBadArguments(t *testing.T) {
	f, cs := newClusterWith(t, nil, withMetrics)
	for name, args := range map[string]map[string]any{
		"missing kind":         {},
		"unknown kind":         {"kind": "deployments"},
		"bad sort":             {"kind": "pods", "sortBy": "disk"},
		"bad namespace":        {"kind": "pods", "namespace": "../x"},
		"bad name":             {"kind": "pods", "namespace": "ns", "name": "a/b"},
		"pod name, no ns":      {"kind": "pods", "name": "web"},
		"node with namespace":  {"kind": "nodes", "namespace": "ns"},
		"node name with slash": {"kind": "nodes", "name": "n/../x"},
	} {
		t.Run(name, func(t *testing.T) {
			if res := call(t, cs, "top", args); !res.IsError {
				t.Errorf("args %v accepted: %s", args, text(res))
			}
		})
	}
	if n := f.count(); n != 0 {
		t.Errorf("rejected arguments still reached the apiserver %d times", n)
	}
}

func TestTopRegisteredOnlyWithMetrics(t *testing.T) {
	_, cs := newClusterWith(t, nil, withMetrics)
	if !hasTool(t, cs, "top") {
		t.Error("top missing with the metrics adapter enabled")
	}
	_, cs = newCluster(t, nil)
	if hasTool(t, cs, "top") {
		t.Error("top listed with the metrics adapter disabled")
	}
}

func hasTool(t *testing.T, cs *sdk.ClientSession, name string) bool {
	t.Helper()
	tools, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	return slices.ContainsFunc(tools.Tools, func(tool *sdk.Tool) bool { return tool.Name == name })
}
