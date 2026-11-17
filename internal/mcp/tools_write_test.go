package mcp

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/n0madic/kube-console/internal/config"
)

// sentinelSecret is Secret data that must never surface in a tool result or
// a log line.
const sentinelSecret = "s3cr3t-value-SENTINEL-5f1c"

func writeMode(o *Options) { o.Mode = config.MCPWrite }

// writeRoutes is a cluster serving legacy discovery for Deployments, Secrets
// and Namespaces, plus extra routes.
func writeRoutes(extra map[string]func(http.ResponseWriter, *http.Request)) map[string]func(http.ResponseWriter, *http.Request) {
	refuseAggregated := func(body string) func(http.ResponseWriter, *http.Request) {
		return func(w http.ResponseWriter, r *http.Request) {
			if strings.Contains(r.Header.Get("Accept"), "APIGroupDiscoveryList") {
				w.WriteHeader(http.StatusNotAcceptable)
				return
			}
			jsonRoute(http.StatusOK, body)(w, r)
		}
	}
	routes := map[string]func(http.ResponseWriter, *http.Request){
		"/api":  refuseAggregated(`{"versions":["v1"]}`),
		"/apis": refuseAggregated(`{"groups":[{"name":"apps","versions":[{"groupVersion":"apps/v1","version":"v1"}]}]}`),
		"/api/v1": jsonRoute(http.StatusOK, `{"groupVersion":"v1","resources":[
			{"name":"secrets","namespaced":true,"kind":"Secret","verbs":["get","patch","delete"]},
			{"name":"namespaces","namespaced":false,"kind":"Namespace","verbs":["get","patch","delete"]}]}`),
		"/apis/apps/v1": jsonRoute(http.StatusOK, `{"groupVersion":"apps/v1","resources":[
			{"name":"deployments","namespaced":true,"kind":"Deployment","verbs":["get","patch","delete"]},
			{"name":"deployments/scale","namespaced":true,"kind":"Scale","verbs":["get","patch"]}]}`),
	}
	for k, v := range extra {
		routes[k] = v
	}
	return routes
}

const deploymentYAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 2
`

func lastWrite(t *testing.T, f *fakeCluster) apiRequest {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.requests) - 1; i >= 0; i-- {
		if f.requests[i].method != http.MethodGet {
			return f.requests[i]
		}
	}
	t.Fatal("no write request reached the apiserver")
	return apiRequest{}
}

func writes(f *fakeCluster) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, r := range f.requests {
		if r.method != http.MethodGet {
			n++
		}
	}
	return n
}

func TestWriteToolsOnlyInWriteMode(t *testing.T) {
	writeTools := []string{"apply_manifest", "delete_resource", "scale", "rollout_restart"}
	_, cs := newCluster(t, nil)
	for _, name := range writeTools {
		if hasTool(t, cs, name) {
			t.Errorf("%s listed in read mode", name)
		}
	}

	_, cs = newClusterWith(t, nil, writeMode)
	tools, err := cs.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]*sdk.Tool{}
	for _, tool := range tools.Tools {
		byName[tool.Name] = tool
	}
	for _, name := range writeTools {
		tool, ok := byName[name]
		if !ok {
			t.Errorf("%s missing in write mode", name)
			continue
		}
		a := tool.Annotations
		if a == nil || a.ReadOnlyHint || a.DestructiveHint == nil || !*a.DestructiveHint {
			t.Errorf("%s must be annotated as a destructive write, got %+v", name, a)
		}
	}
	for _, name := range []string{"apply_manifest", "scale"} {
		if tool := byName[name]; tool != nil && (tool.Annotations == nil || !tool.Annotations.IdempotentHint) {
			t.Errorf("%s is idempotent", name)
		}
	}
	// The read tools stay read-only in write mode.
	if tool := byName["get_resource"]; tool == nil || tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
		t.Errorf("get_resource missing or lost its read-only annotation: %+v", tool)
	}
}

type applyResult struct {
	DryRun     bool   `json:"dryRun"`
	Operation  string `json:"operation"`
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Namespace  string `json:"namespace"`
	Name       string `json:"name"`
	UID        string `json:"uid"`
}

func TestApplyManifestDryRunByDefault(t *testing.T) {
	const path = "/apis/apps/v1/namespaces/shop/deployments/web"
	f, cs := newClusterWith(t, writeRoutes(map[string]func(http.ResponseWriter, *http.Request){
		path: jsonRoute(http.StatusCreated, `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"shop","uid":"u-1"}}`),
	}), writeMode)

	out := structured[applyResult](t, call(t, cs, "apply_manifest", map[string]any{"manifest": deploymentYAML}))
	if !out.DryRun || out.Operation != "created" || out.Kind != "Deployment" || out.Namespace != "shop" || out.Name != "web" || out.UID != "u-1" {
		t.Errorf("result = %+v", out)
	}
	req := lastWrite(t, f)
	if req.method != http.MethodPatch || req.path != path {
		t.Fatalf("sent %s %s", req.method, req.path)
	}
	if req.contentType != "application/apply-patch+yaml" {
		t.Errorf("content type = %q", req.contentType)
	}
	if got := req.query.Get("dryRun"); got != "All" {
		t.Errorf("dryRun = %q: an apply without commit must not write", got)
	}
	if got := req.query.Get("fieldManager"); got != "kube-console-mcp" {
		t.Errorf("fieldManager = %q", got)
	}
	// No force: a conflict is for the agent (or its user) to resolve, never
	// to steamroll.
	if req.query.Has("force") {
		t.Errorf("force sent: %v", req.query)
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(req.body), &sent); err != nil || sent["kind"] != "Deployment" {
		t.Errorf("body = %q (%v)", req.body, err)
	}

	out = structured[applyResult](t, call(t, cs, "apply_manifest", map[string]any{"manifest": deploymentYAML, "commit": true}))
	if out.DryRun {
		t.Error("commit=true still reported a dry run")
	}
	if req := lastWrite(t, f); req.query.Has("dryRun") {
		t.Errorf("commit=true sent dryRun: %v", req.query)
	}
}

func TestApplyManifestUpdateAndConflict(t *testing.T) {
	conflict := false
	f, cs := newClusterWith(t, writeRoutes(map[string]func(http.ResponseWriter, *http.Request){
		"/apis/apps/v1/namespaces/shop/deployments/web": func(w http.ResponseWriter, r *http.Request) {
			if conflict {
				jsonRoute(http.StatusConflict, `{"kind":"Status","reason":"Conflict","message":"Apply failed with 1 conflict: conflict with \"kubectl-client-side-apply\": .spec.replicas"}`)(w, r)
				return
			}
			jsonRoute(http.StatusOK, `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"shop"}}`)(w, r)
		},
	}), writeMode)

	if out := structured[applyResult](t, call(t, cs, "apply_manifest", map[string]any{"manifest": deploymentYAML})); out.Operation != "updated" {
		t.Errorf("operation = %q, want updated", out.Operation)
	}
	conflict = true
	res := call(t, cs, "apply_manifest", map[string]any{"manifest": deploymentYAML, "commit": true})
	if !res.IsError || !strings.Contains(text(res), "409") || !strings.Contains(text(res), "kubectl-client-side-apply") {
		t.Errorf("conflict = %v %q", res.IsError, text(res))
	}
	if req := lastWrite(t, f); req.query.Has("force") {
		t.Error("a conflict must not be retried with force")
	}
}

// force takes field ownership away from other managers, so it reaches the
// apiserver only when asked for in so many words — and, like every write,
// stays a dry run until committed.
func TestApplyManifestForce(t *testing.T) {
	f, cs := newClusterWith(t, writeRoutes(map[string]func(http.ResponseWriter, *http.Request){
		"/apis/apps/v1/namespaces/shop/deployments/web": jsonRoute(http.StatusOK,
			`{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"shop"}}`),
	}), writeMode)

	structured[applyResult](t, call(t, cs, "apply_manifest", map[string]any{"manifest": deploymentYAML, "force": false, "commit": true}))
	if req := lastWrite(t, f); req.query.Has("force") {
		t.Errorf("force=false sent force: %v", req.query)
	}

	out := structured[applyResult](t, call(t, cs, "apply_manifest", map[string]any{"manifest": deploymentYAML, "force": true}))
	req := lastWrite(t, f)
	if req.query.Get("force") != "true" || req.query.Get("dryRun") != "All" || !out.DryRun {
		t.Errorf("force without commit: query %v, result %+v; want a forced dry run", req.query, out)
	}

	structured[applyResult](t, call(t, cs, "apply_manifest", map[string]any{"manifest": deploymentYAML, "force": true, "commit": true}))
	if req := lastWrite(t, f); req.query.Get("force") != "true" || req.query.Has("dryRun") {
		t.Errorf("force with commit: query %v", req.query)
	}
}

func TestApplyManifestRejects(t *testing.T) {
	f, cs := newClusterWith(t, writeRoutes(nil), writeMode)
	for name, manifest := range map[string]string{
		"empty":                 "",
		"not yaml":              "apiVersion: [unclosed",
		"not an object":         "- a\n- b\n",
		"two documents":         deploymentYAML + "---\n" + deploymentYAML,
		"two documents, json":   `{"apiVersion":"v1","kind":"Secret","metadata":{"name":"a","namespace":"n"}}` + "\n---\n" + `{"apiVersion":"v1"}`,
		"list kind":             "apiVersion: v1\nkind: List\nitems: []\n",
		"no kind":               "apiVersion: v1\nmetadata:\n  name: a\n  namespace: n\n",
		"no name":               "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  namespace: shop\n",
		"generateName only":     "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  generateName: web-\n  namespace: shop\n",
		"unknown kind":          "apiVersion: apps/v1\nkind: Gizmo\nmetadata:\n  name: a\n  namespace: shop\n",
		"bad apiVersion":        "apiVersion: ../v1\nkind: Deployment\nmetadata:\n  name: a\n  namespace: shop\n",
		"namespaced, no ns":     "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n",
		"cluster-scoped, ns":    "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: team\n  namespace: shop\n",
		"bad name":              "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: a/exec\n  namespace: shop\n",
		"bad namespace":         "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: a\n  namespace: Shop_1\n",
		"name not a string":     "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: 7\n  namespace: shop\n",
		"metadata not a object": "apiVersion: apps/v1\nkind: Deployment\nmetadata: web\n",
	} {
		t.Run(name, func(t *testing.T) {
			if res := call(t, cs, "apply_manifest", map[string]any{"manifest": manifest, "commit": true}); !res.IsError {
				t.Errorf("accepted: %s", text(res))
			}
		})
	}
	if n := writes(f); n != 0 {
		t.Errorf("rejected manifests still sent %d writes", n)
	}
}

// The kind is resolved from the manifest's own group version — one GET of its
// APIResourceList — not from the whole cluster's catalog: on a cluster without
// aggregated discovery that was one request per group version, every apply,
// inside the same budget the PATCH needs.
func TestApplyManifestLooksUpOnlyItsGroupVersion(t *testing.T) {
	f, cs := newClusterWith(t, writeRoutes(map[string]func(http.ResponseWriter, *http.Request){
		"/apis/apps/v1/namespaces/shop/deployments/web": jsonRoute(http.StatusOK,
			`{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"shop"}}`),
	}), writeMode)
	structured[applyResult](t, call(t, cs, "apply_manifest", map[string]any{"manifest": deploymentYAML}))
	f.mu.Lock()
	var reads []string
	for _, r := range f.requests {
		if r.method == http.MethodGet {
			reads = append(reads, r.path)
		}
	}
	f.mu.Unlock()
	if strings.Join(reads, ",") != "/apis/apps/v1" {
		t.Errorf("reads = %v, want only the manifest's group version", reads)
	}
}

// A kind whose name ends in "List" is an ordinary kind when the cluster
// serves it; list kinds themselves are never served, so the lookup refuses
// them without a name rule.
func TestApplyManifestKindEndingInList(t *testing.T) {
	f, cs := newClusterWith(t, writeRoutes(map[string]func(http.ResponseWriter, *http.Request){
		"/apis/example.com/v1": jsonRoute(http.StatusOK, `{"groupVersion":"example.com/v1","resources":[
			{"name":"accesslists","namespaced":true,"kind":"AccessList","verbs":["get","patch"]}]}`),
		"/apis/example.com/v1/namespaces/shop/accesslists/team": jsonRoute(http.StatusCreated,
			`{"apiVersion":"example.com/v1","kind":"AccessList","metadata":{"name":"team","namespace":"shop"}}`),
	}), writeMode)
	manifest := "apiVersion: example.com/v1\nkind: AccessList\nmetadata:\n  name: team\n  namespace: shop\n"
	if out := structured[applyResult](t, call(t, cs, "apply_manifest", map[string]any{"manifest": manifest})); out.Operation != "created" {
		t.Errorf("result = %+v", out)
	}
	if req := lastWrite(t, f); req.path != "/apis/example.com/v1/namespaces/shop/accesslists/team" {
		t.Errorf("sent %s %s", req.method, req.path)
	}

	// A group version the cluster does not serve is the same answer as an
	// unknown kind, and a denial keeps its status.
	res := call(t, cs, "apply_manifest", map[string]any{"manifest": "apiVersion: example.com/v9\nkind: AccessList\nmetadata:\n  name: team\n  namespace: shop\n"})
	if !res.IsError || !strings.Contains(text(res), "not served") {
		t.Errorf("unserved group version = %v %q", res.IsError, text(res))
	}
	f.routes["/apis/example.com/v1"] = jsonRoute(http.StatusForbidden, `{"kind":"Status","reason":"Forbidden","message":"forbidden: discovery"}`)
	res = call(t, cs, "apply_manifest", map[string]any{"manifest": manifest})
	if !res.IsError || !strings.Contains(text(res), "403") {
		t.Errorf("denied lookup = %v %q", res.IsError, text(res))
	}
}

// A Secret manifest is the one argument that is itself a secret: neither the
// result nor the log may carry its data, whatever the apiserver echoes back.
func TestApplySecretNeverEchoed(t *testing.T) {
	_, cs, fx := startCluster(t, writeRoutes(map[string]func(http.ResponseWriter, *http.Request){
		"/api/v1/namespaces/shop/secrets/db": jsonRoute(http.StatusOK,
			`{"apiVersion":"v1","kind":"Secret","metadata":{"name":"db","namespace":"shop"},"stringData":{"password":"`+sentinelSecret+`"}}`),
	}), writeMode)
	manifest := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: shop\nstringData:\n  password: " + sentinelSecret + "\n"
	res := call(t, cs, "apply_manifest", map[string]any{"manifest": manifest})
	raw, _ := json.Marshal(res)
	if res.IsError || strings.Contains(string(raw), sentinelSecret) {
		t.Errorf("result leaked the secret or failed: %s", raw)
	}
	if logs := fx.logText(); strings.Contains(logs, sentinelSecret) {
		t.Errorf("secret data in the log:\n%s", logs)
	}
}

type deleteResult struct {
	DryRun bool   `json:"dryRun"`
	Result string `json:"result"`
}

func TestDeleteResource(t *testing.T) {
	const path = "/apis/apps/v1/namespaces/shop/deployments/web"
	f, cs := newClusterWith(t, writeRoutes(map[string]func(http.ResponseWriter, *http.Request){
		path: jsonRoute(http.StatusOK, `{"kind":"Status","apiVersion":"v1","status":"Success"}`),
	}), writeMode)
	args := map[string]any{"apiVersion": "apps/v1", "resource": "deployments", "namespace": "shop", "name": "web"}

	out := structured[deleteResult](t, call(t, cs, "delete_resource", args))
	if !out.DryRun || out.Result != "deleted" {
		t.Errorf("result = %+v", out)
	}
	req := lastWrite(t, f)
	if req.method != http.MethodDelete || req.path != path || req.query.Get("dryRun") != "All" {
		t.Errorf("sent %s %s %v", req.method, req.path, req.query)
	}
	if got := req.query.Get("propagationPolicy"); got != "Background" {
		t.Errorf("propagationPolicy = %q", got)
	}

	args["commit"] = true
	structured[deleteResult](t, call(t, cs, "delete_resource", args))
	if req := lastWrite(t, f); req.query.Has("dryRun") {
		t.Errorf("commit=true sent dryRun: %v", req.query)
	}
}

func TestDeleteResourceInProgressAndRejects(t *testing.T) {
	f, cs := newClusterWith(t, writeRoutes(map[string]func(http.ResponseWriter, *http.Request){
		// An object with finalizers comes back as the object, still present.
		"/api/v1/namespaces/team": jsonRoute(http.StatusOK,
			`{"kind":"Namespace","apiVersion":"v1","metadata":{"name":"team","deletionTimestamp":"2026-11-17T10:00:00Z"}}`),
	}), writeMode)
	out := structured[deleteResult](t, call(t, cs, "delete_resource",
		map[string]any{"apiVersion": "v1", "resource": "namespaces", "name": "team", "commit": true}))
	if out.Result == "deleted" {
		t.Errorf("an object still present must not read as deleted: %+v", out)
	}

	before := writes(f)
	for name, args := range map[string]map[string]any{
		// No name would address the collection: a DELETE there removes every
		// object in it.
		"no name":      {"apiVersion": "apps/v1", "resource": "deployments", "namespace": "shop", "commit": true},
		"bad resource": {"apiVersion": "v1", "resource": "pods/exec", "namespace": "shop", "name": "p", "commit": true},
		"bad name":     {"apiVersion": "v1", "resource": "pods", "namespace": "shop", "name": "..", "commit": true},
	} {
		t.Run(name, func(t *testing.T) {
			if res := call(t, cs, "delete_resource", args); !res.IsError {
				t.Errorf("accepted: %s", text(res))
			}
		})
	}
	if n := writes(f) - before; n != 0 {
		t.Errorf("rejected deletes still sent %d writes", n)
	}
}

type scaleResult struct {
	DryRun          bool `json:"dryRun"`
	Replicas        int  `json:"replicas"`
	CurrentReplicas int  `json:"currentReplicas"`
}

func TestScale(t *testing.T) {
	const path = "/apis/apps/v1/namespaces/shop/deployments/web/scale"
	f, cs := newClusterWith(t, writeRoutes(map[string]func(http.ResponseWriter, *http.Request){
		path: jsonRoute(http.StatusOK, `{"kind":"Scale","spec":{"replicas":3},"status":{"replicas":2}}`),
	}), writeMode)
	args := map[string]any{"apiVersion": "apps/v1", "resource": "deployments", "namespace": "shop", "name": "web", "replicas": 3}

	out := structured[scaleResult](t, call(t, cs, "scale", args))
	if !out.DryRun || out.Replicas != 3 || out.CurrentReplicas != 2 {
		t.Errorf("result = %+v", out)
	}
	req := lastWrite(t, f)
	if req.method != http.MethodPatch || req.path != path || req.contentType != "application/merge-patch+json" {
		t.Fatalf("sent %s %s (%s)", req.method, req.path, req.contentType)
	}
	if req.body != `{"spec":{"replicas":3}}` {
		t.Errorf("body = %s", req.body)
	}
	if req.query.Get("dryRun") != "All" || req.query.Get("fieldManager") != "kube-console-mcp" {
		t.Errorf("query = %v", req.query)
	}

	// Scaling to zero is a legitimate request, as long as it is explicit.
	args["replicas"], args["commit"] = 0, true
	structured[scaleResult](t, call(t, cs, "scale", args))
	if req := lastWrite(t, f); req.body != `{"spec":{"replicas":0}}` || req.query.Has("dryRun") {
		t.Errorf("scale to zero sent %s %v", req.body, req.query)
	}
}

func TestScaleRejects(t *testing.T) {
	f, cs := newClusterWith(t, writeRoutes(nil), writeMode)
	base := func(extra map[string]any) map[string]any {
		args := map[string]any{"apiVersion": "apps/v1", "resource": "deployments", "namespace": "shop", "name": "web", "commit": true}
		for k, v := range extra {
			args[k] = v
		}
		return args
	}
	for name, args := range map[string]map[string]any{
		// A forgotten replicas must not read as zero: that would scale the
		// workload away.
		"no replicas": base(nil),
		// The schema requires the key but admits null for a pointer, so this
		// case reaches the handler's own check.
		"null replicas": base(map[string]any{"replicas": nil}),
		"negative":      base(map[string]any{"replicas": -1}),
		"too many":      base(map[string]any{"replicas": 1 << 31}),
		"no name":       base(map[string]any{"replicas": 1, "name": ""}),
	} {
		t.Run(name, func(t *testing.T) {
			if res := call(t, cs, "scale", args); !res.IsError {
				t.Errorf("accepted: %s", text(res))
			}
		})
	}
	if n := writes(f); n != 0 {
		t.Errorf("rejected scales still sent %d writes", n)
	}
}

type restartResult struct {
	DryRun      bool   `json:"dryRun"`
	RestartedAt string `json:"restartedAt"`
}

func TestRolloutRestart(t *testing.T) {
	const path = "/apis/apps/v1/namespaces/shop/statefulsets/db"
	f, cs := newClusterWith(t, writeRoutes(map[string]func(http.ResponseWriter, *http.Request){
		path: jsonRoute(http.StatusOK, `{"kind":"StatefulSet","metadata":{"name":"db"}}`),
	}), writeMode)

	out := structured[restartResult](t, call(t, cs, "rollout_restart", map[string]any{"resource": "statefulsets", "namespace": "shop", "name": "db"}))
	if !out.DryRun {
		t.Error("restart without commit must be a dry run")
	}
	if _, err := time.Parse(time.RFC3339, out.RestartedAt); err != nil {
		t.Errorf("restartedAt = %q: %v", out.RestartedAt, err)
	}
	req := lastWrite(t, f)
	if req.method != http.MethodPatch || req.path != path || req.contentType != "application/strategic-merge-patch+json" {
		t.Fatalf("sent %s %s (%s)", req.method, req.path, req.contentType)
	}
	var patch struct {
		Spec struct {
			Template struct {
				Metadata struct {
					Annotations map[string]string `json:"annotations"`
				} `json:"metadata"`
			} `json:"template"`
		} `json:"spec"`
	}
	if err := json.Unmarshal([]byte(req.body), &patch); err != nil {
		t.Fatal(err)
	}
	// The annotation kubectl rollout restart and the UI both use.
	if got := patch.Spec.Template.Metadata.Annotations["kubectl.kubernetes.io/restartedAt"]; got != out.RestartedAt {
		t.Errorf("annotation = %q, result says %q", got, out.RestartedAt)
	}
	if req.query.Get("dryRun") != "All" || req.query.Get("fieldManager") != "kube-console-mcp" {
		t.Errorf("query = %v", req.query)
	}

	before := writes(f)
	for _, args := range []map[string]any{
		{"resource": "cronjobs", "namespace": "shop", "name": "db"},
		{"resource": "statefulsets", "name": "db"},
		{"resource": "statefulsets", "namespace": "shop"},
	} {
		if res := call(t, cs, "rollout_restart", args); !res.IsError {
			t.Errorf("args %v accepted: %s", args, text(res))
		}
	}
	if n := writes(f) - before; n != 0 {
		t.Errorf("rejected restarts still sent %d writes", n)
	}
}
