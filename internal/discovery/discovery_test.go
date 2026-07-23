package discovery

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/n0madic/kube-console/internal/kube"
)

func newDiscoveryHandler(t *testing.T, upstream http.HandlerFunc) *Handler {
	t.Helper()
	ts := httptest.NewServer(upstream)
	t.Cleanup(ts.Close)
	base, _ := url.Parse(ts.URL)
	up := &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport}
	reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up})
	return NewHandler(reg, slog.New(slog.DiscardHandler))
}

func getDiscovery(h *Handler, token string) *httptest.ResponseRecorder {
	return getDiscoveryContext(h, token, "")
}

func getDiscoveryContext(h *Handler, token, context string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/ui/discovery", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if context != "" {
		req.Header.Set("X-Kube-Context", context)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeResources(t *testing.T, rec *httptest.ResponseRecorder) map[string]Resource {
	t.Helper()
	var out Response
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad response body: %v", err)
	}
	byID := map[string]Resource{}
	for _, r := range out.Resources {
		byID[r.ID] = r
	}
	return byID
}

const aggregatedApis = `{
  "kind": "APIGroupDiscoveryList",
  "items": [
    {
      "metadata": {"name": "apps"},
      "versions": [
        {
          "version": "v1",
          "resources": [
            {
              "resource": "deployments",
              "responseKind": {"kind": "Deployment"},
              "scope": "Namespaced",
              "verbs": ["get","list","watch","create","patch","delete"],
              "shortNames": ["deploy"],
              "categories": ["all"],
              "subresources": [{"subresource": "status"}]
            }
          ]
        }
      ]
    }
  ]
}`

const aggregatedApi = `{
  "kind": "APIGroupDiscoveryList",
  "items": [
    {
      "metadata": {"name": ""},
      "versions": [
        {
          "version": "v1",
          "resources": [
            {
              "resource": "pods",
              "responseKind": {"kind": "Pod"},
              "scope": "Namespaced",
              "verbs": ["get","list","watch","create","patch","delete"],
              "shortNames": ["po"],
              "categories": ["all"]
            },
            {
              "resource": "nodes",
              "responseKind": {"kind": "Node"},
              "scope": "Cluster",
              "verbs": ["get","list","watch"]
            }
          ]
        }
      ]
    }
  ]
}`

func TestDiscoveryAggregated(t *testing.T) {
	h := newDiscoveryHandler(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept"), "apidiscovery.k8s.io") {
			t.Errorf("expected aggregated Accept header, got %q", r.Header.Get("Accept"))
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/apis":
			_, _ = w.Write([]byte(aggregatedApis))
		case "/api":
			_, _ = w.Write([]byte(aggregatedApi))
		default:
			t.Errorf("unexpected upstream path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	rec := getDiscovery(h, "tok")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	byID := decodeResources(t, rec)

	pods, ok := byID["core/v1/pods"]
	if !ok {
		t.Fatalf("core/v1/pods missing; got %v", keys(byID))
	}
	if pods.Group != "" || pods.Kind != "Pod" || !pods.Namespaced {
		t.Errorf("pods DTO mismatch: %+v", pods)
	}
	if pods.ShortNames[0] != "po" || pods.Categories[0] != "all" {
		t.Errorf("pods shortNames/categories mismatch: %+v", pods)
	}
	nodes := byID["core/v1/nodes"]
	if nodes.Namespaced {
		t.Error("nodes must be cluster-scoped")
	}
	deploy, ok := byID["apps/v1/deployments"]
	if !ok || deploy.Group != "apps" || deploy.Kind != "Deployment" {
		t.Errorf("deployments DTO mismatch: %+v", deploy)
	}
}

func TestDiscoveryLegacyFallback(t *testing.T) {
	h := newDiscoveryHandler(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/apis":
			// Server without aggregated discovery support answers 200 with a
			// plain APIGroupList regardless of the Accept header.
			_, _ = w.Write([]byte(`{
				"kind": "APIGroupList",
				"groups": [
					{"name":"apps","versions":[{"groupVersion":"apps/v1","version":"v1"}],
					 "preferredVersion":{"groupVersion":"apps/v1","version":"v1"}},
					{"name":"broken.example.io","versions":[{"groupVersion":"broken.example.io/v1","version":"v1"}],
					 "preferredVersion":{"groupVersion":"broken.example.io/v1","version":"v1"}}
				]}`))
		case "/api":
			_, _ = w.Write([]byte(`{"kind":"APIVersions","versions":["v1"]}`))
		case "/api/v1":
			_, _ = w.Write([]byte(`{
				"kind":"APIResourceList","groupVersion":"v1",
				"resources":[
					{"name":"pods","namespaced":true,"kind":"Pod","verbs":["get","list","watch"],"shortNames":["po"],"categories":["all"]},
					{"name":"pods/log","namespaced":true,"kind":"Pod","verbs":["get"]},
					{"name":"pods/exec","namespaced":true,"kind":"PodExecOptions","verbs":["create"]}
				]}`))
		case "/apis/apps/v1":
			_, _ = w.Write([]byte(`{
				"kind":"APIResourceList","groupVersion":"apps/v1",
				"resources":[{"name":"deployments","namespaced":true,"kind":"Deployment","verbs":["get","list"]}]}`))
		case "/apis/broken.example.io/v1":
			w.WriteHeader(http.StatusServiceUnavailable)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	rec := getDiscovery(h, "tok")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	byID := decodeResources(t, rec)

	if _, ok := byID["core/v1/pods"]; !ok {
		t.Fatalf("core/v1/pods missing; got %v", keys(byID))
	}
	if _, ok := byID["apps/v1/deployments"]; !ok {
		t.Error("apps/v1/deployments missing")
	}
	for id := range byID {
		if strings.Contains(id, "pods/") {
			t.Errorf("subresource leaked into discovery: %s", id)
		}
		if strings.Contains(id, "broken.example.io") {
			t.Errorf("broken group must be skipped, got %s", id)
		}
	}
}

func TestDiscoveryMissingBearer(t *testing.T) {
	h := newDiscoveryHandler(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("upstream must not be called")
	})
	rec := getDiscovery(h, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// A cluster that unbinds system:discovery from system:authenticated answers
// 403 on the discovery roots. That is an RBAC denial, not an unreachable
// apiserver, and must surface as 403 — a 502 sends the operator chasing
// network problems.
func TestDiscoveryForbidden(t *testing.T) {
	h := newDiscoveryHandler(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})
	rec := getDiscovery(h, "tok")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"reason":"Forbidden"`) {
		t.Fatalf("body must carry reason Forbidden: %s", rec.Body.String())
	}
}

// Discovery must query the upstream selected by X-Kube-Context.
func TestDiscoveryRoutesByContext(t *testing.T) {
	minimal := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/apis":
			_, _ = w.Write([]byte(`{"kind":"APIGroupDiscoveryList","items":[]}`))
		case "/api":
			_, _ = w.Write([]byte(`{"kind":"APIGroupDiscoveryList","items":[]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("alpha must not be contacted for a beta request")
	}))
	t.Cleanup(alpha.Close)
	betaHit := false
	beta := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		betaHit = true
		minimal(w, r)
	}))
	t.Cleanup(beta.Close)
	alphaBase, _ := url.Parse(alpha.URL)
	betaBase, _ := url.Parse(beta.URL)
	reg := kube.NewRegistryFromUpstreams("alpha", map[string]*kube.Upstream{
		"alpha": {BaseURL: alphaBase, Transport: http.DefaultTransport},
		"beta":  {BaseURL: betaBase, Transport: http.DefaultTransport},
	})
	h := NewHandler(reg, slog.New(slog.DiscardHandler))

	if rec := getDiscoveryContext(h, "tok", "beta"); rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !betaHit {
		t.Fatal("beta upstream was not contacted")
	}
}

func TestDiscoveryUnknownContext400(t *testing.T) {
	h := newDiscoveryHandler(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("upstream must not be called for an unknown context")
	})
	rec := getDiscoveryContext(h, "tok", "ghost")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for unknown context", rec.Code)
	}
}

func keys(m map[string]Resource) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// Regression: a nonstandard aggregated API may omit "verbs" on a resource;
// the DTO must serialize it as [] — "verbs": null crashed the SPA sidebar.
func TestDiscoveryOmittedVerbsSerializeAsEmptyArray(t *testing.T) {
	const apisNoVerbs = `{
	  "kind": "APIGroupDiscoveryList",
	  "items": [
	    {
	      "metadata": {"name": "x.example.com"},
	      "versions": [
	        {
	          "version": "v1",
	          "resources": [
	            {
	              "resource": "things",
	              "responseKind": {"kind": "Thing"},
	              "scope": "Namespaced"
	            }
	          ]
	        }
	      ]
	    }
	  ]
	}`
	h := newDiscoveryHandler(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/apis":
			_, _ = w.Write([]byte(apisNoVerbs))
		case "/api":
			_, _ = w.Write([]byte(`{"kind":"APIGroupDiscoveryList","items":[]}`))
		default:
			t.Errorf("unexpected upstream path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	rec := getDiscovery(h, "tok")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"verbs":[]`) {
		t.Errorf(`response must serialize omitted verbs as "verbs":[]; body: %s`, rec.Body.String())
	}
}
