package mcp

import (
	"strings"
	"testing"

	"github.com/n0madic/kube-console/internal/gateway"
)

func TestTargetPathBuilds(t *testing.T) {
	cases := []struct {
		name string
		in   target
		want string
	}{
		{"core collection, all namespaces", target{APIVersion: "v1", Resource: "pods"}, "/api/v1/pods"},
		{"core collection in a namespace", target{APIVersion: "v1", Resource: "pods", Namespace: "kube-system"}, "/api/v1/namespaces/kube-system/pods"},
		{"core object", target{APIVersion: "v1", Resource: "pods", Namespace: "ns", Name: "web-0"}, "/api/v1/namespaces/ns/pods/web-0"},
		{"group collection", target{APIVersion: "apps/v1", Resource: "deployments", Namespace: "ns"}, "/apis/apps/v1/namespaces/ns/deployments"},
		{"cluster-scoped object", target{APIVersion: "v1", Resource: "nodes", Name: "node-1"}, "/api/v1/nodes/node-1"},
		// RBAC names are not DNS-1123: colons are ordinary there.
		{"rbac name with colons", target{APIVersion: "rbac.authorization.k8s.io/v1", Resource: "clusterroles", Name: "system:controller:job-controller"},
			"/apis/rbac.authorization.k8s.io/v1/clusterroles/system:controller:job-controller"},
		// The apiserver's own rule for a name in a path is "not . or .., no
		// / or %"; anything else is legal there and is escaped, never refused —
		// a query string cannot be smuggled through a name.
		{"name escaped", target{APIVersion: "v1", Resource: "pods", Namespace: "ns", Name: "a?watch=1#x y"}, "/api/v1/namespaces/ns/pods/a%3Fwatch=1%23x%20y"},
		{"subresource", target{APIVersion: "v1", Resource: "pods", Namespace: "ns", Name: "p", Subresource: "log"}, "/api/v1/namespaces/ns/pods/p/log"},
		{"beta version", target{APIVersion: "autoscaling/v2beta2", Resource: "horizontalpodautoscalers"}, "/apis/autoscaling/v2beta2/horizontalpodautoscalers"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := tc.in.path()
			if err != nil {
				t.Fatalf("path() error: %v", err)
			}
			if got != tc.want {
				t.Errorf("path() = %q, want %q", got, tc.want)
			}
			if err := gateway.CheckPath(got); err != nil {
				t.Errorf("built path %q fails the gateway policy: %v", got, err)
			}
		})
	}
}

// Every argument reaches the upstream URL, so anything that could add,
// remove or re-interpret a path segment is refused before a request exists.
func TestTargetPathRejects(t *testing.T) {
	cases := []struct {
		name string
		in   target
	}{
		{"empty apiVersion", target{Resource: "pods"}},
		{"bad version", target{APIVersion: "1", Resource: "pods"}},
		{"version only group", target{APIVersion: "apps", Resource: "deployments"}},
		{"three-part apiVersion", target{APIVersion: "apps/v1/x", Resource: "deployments"}},
		{"empty group", target{APIVersion: "/v1", Resource: "pods"}},
		{"traversal in group", target{APIVersion: "../v1", Resource: "pods"}},
		{"uppercase group", target{APIVersion: "Apps/v1", Resource: "deployments"}},
		{"empty resource", target{APIVersion: "v1"}},
		{"uppercase resource", target{APIVersion: "v1", Resource: "Pods"}},
		{"resource with slash", target{APIVersion: "v1", Resource: "pods/exec"}},
		{"resource exec", target{APIVersion: "v1", Resource: "exec"}},
		{"resource proxy", target{APIVersion: "v1", Resource: "proxy"}},
		{"bad namespace", target{APIVersion: "v1", Resource: "pods", Namespace: "Kube_System"}},
		{"namespace traversal", target{APIVersion: "v1", Resource: "pods", Namespace: ".."}},
		{"name with slash", target{APIVersion: "v1", Resource: "pods", Namespace: "ns", Name: "a/exec"}},
		{"name with backslash", target{APIVersion: "v1", Resource: "pods", Namespace: "ns", Name: `a\b`}},
		{"name with percent", target{APIVersion: "v1", Resource: "pods", Namespace: "ns", Name: "a%2fexec"}},
		{"name dot", target{APIVersion: "v1", Resource: "pods", Namespace: "ns", Name: "."}},
		{"name dotdot", target{APIVersion: "v1", Resource: "pods", Namespace: "ns", Name: ".."}},
		{"name with newline", target{APIVersion: "v1", Resource: "pods", Namespace: "ns", Name: "a\nb"}},
		{"name too long", target{APIVersion: "v1", Resource: "pods", Namespace: "ns", Name: strings.Repeat("a", 254)}},
		// An object literally named exec is unreachable, exactly as through
		// the gateway (the documented limitation).
		{"name exec", target{APIVersion: "v1", Resource: "pods", Namespace: "ns", Name: "exec"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := tc.in.path(); err == nil {
				t.Errorf("path() = %q, want an error", got)
			}
		})
	}
}
