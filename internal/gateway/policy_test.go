package gateway

import (
	"errors"
	"testing"
)

func TestCheckPathAllowed(t *testing.T) {
	allowed := []string{
		"/version",
		"/api",
		"/apis",
		"/openapi",
		"/openapi/v3",
		"/api/v1",
		"/api/v1/pods",
		"/api/v1/namespaces/default/pods",
		"/api/v1/namespaces/default/pods/api-123/log",
		"/apis/apps/v1/deployments",
		// Subresource used by the detail page's Scale action; only
		// exec|attach|portforward|proxy are blocked.
		"/apis/apps/v1/namespaces/default/deployments/web/scale",
		"/api/v1/namespaces/default/replicationcontrollers/web/scale",
		"/apis/metrics.k8s.io/v1beta1/pods",
		"/apis/apiextensions.k8s.io/v1/customresourcedefinitions",
	}
	for _, p := range allowed {
		if err := CheckPath(p); err != nil {
			t.Errorf("CheckPath(%q) = %v, want nil", p, err)
		}
	}
}

func TestCheckPathBlockedSubresources(t *testing.T) {
	blocked := []string{
		"/api/v1/namespaces/default/pods/api-123/exec",
		"/api/v1/namespaces/default/pods/api-123/attach",
		"/api/v1/namespaces/default/pods/api-123/portforward",
		"/api/v1/namespaces/default/pods/api-123/proxy",
		"/api/v1/namespaces/default/services/svc/proxy",
		"/api/v1/namespaces/default/services/svc/proxy/metrics",
		"/api/v1/nodes/node-1/proxy",
		"/api/v1/namespaces/default/pods/api-123/EXEC",
		"/api/v1/namespaces/default/pods/api-123/%65xec", // percent-encoded "exec"
	}
	for _, p := range blocked {
		if err := CheckPath(p); !errors.Is(err, ErrForbiddenPath) {
			t.Errorf("CheckPath(%q) = %v, want ErrForbiddenPath", p, err)
		}
	}
}

func TestCheckPathForbiddenRoots(t *testing.T) {
	forbidden := []string{
		"/metrics",
		"/logs",
		"/healthz",
		"/livez",
		"/api-foo",
		"/foo/api",
	}
	for _, p := range forbidden {
		if err := CheckPath(p); !errors.Is(err, ErrForbiddenPath) {
			t.Errorf("CheckPath(%q) = %v, want ErrForbiddenPath", p, err)
		}
	}
}

func TestCheckPathMalformed(t *testing.T) {
	malformed := []string{
		"",
		"api",
		"/",
		"/api/",
		"/api//v1",
		"/api/./v1",
		"/api/../version",
		"/api/%2e%2e/version",
		"/api/%2E%2e/version",
		"/api/v1/foo%2Fbar",
		"/api/v1/foo%2fbar",
		"/api/v1/foo%5Cbar",
		"/api/v1/foo%zz",
		// Double-encoded payloads: one unescape leaves a residual %-escape, which
		// must be rejected rather than forwarded for a second decode upstream.
		"/api/v1/foo%252fbar",       // %25 2f → %2f (encoded slash)
		"/api/%252e%252e/version",   // %252e%252e → %2e%2e (encoded dot-dot)
		"/api/v1/foo%2565xec",       // %2565xec → %65xec (double-encoded "exec")
		"/api/v1/foo%25bar",         // lone encoded percent
	}
	for _, p := range malformed {
		if err := CheckPath(p); !errors.Is(err, ErrBadPath) {
			t.Errorf("CheckPath(%q) = %v, want ErrBadPath", p, err)
		}
	}
}

func TestCheckPathLogAllowed(t *testing.T) {
	if err := CheckPath("/api/v1/namespaces/ns/pods/p/log"); err != nil {
		t.Fatalf("log subresource must be allowed, got %v", err)
	}
}
