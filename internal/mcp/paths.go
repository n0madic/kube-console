package mcp

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"unicode"

	"github.com/n0madic/kube-console/internal/gateway"
	"github.com/n0madic/kube-console/internal/kube"
)

// maxNameBytes bounds an object name: the longest legal Kubernetes name
// (a DNS-1123 subdomain) is 253 bytes.
const maxNameBytes = 253

// target names one collection or object, as the tools take it from their
// arguments. Subresource is set by tool code, never by an argument.
type target struct {
	APIVersion  string
	Resource    string
	Namespace   string
	Name        string
	Subresource string
}

// path validates every part and builds the upstream path. Each part is checked
// on its own shape first, so the error names the argument at fault; the result
// is then put through gateway.CheckPath, so the MCP tools can never reach a
// path the /k8s gateway would refuse (exec, attach, portforward, proxy) — one
// policy, not two.
func (t target) path() (string, error) {
	var b strings.Builder
	gv, err := groupVersionPath(t.APIVersion)
	if err != nil {
		return "", err
	}
	b.WriteString(gv)
	if t.Namespace != "" {
		if !kube.IsDNS1123Label(t.Namespace) {
			return "", fmt.Errorf("invalid namespace %q", t.Namespace)
		}
		b.WriteString("/namespaces/" + t.Namespace)
	}
	if !kube.IsDNS1123Label(t.Resource) {
		return "", fmt.Errorf("invalid resource %q: want the lowercase plural name, such as \"deployments\"", t.Resource)
	}
	b.WriteString("/" + t.Resource)
	if t.Name != "" {
		if err := validName(t.Name); err != nil {
			return "", err
		}
		b.WriteString("/" + url.PathEscape(t.Name))
	}
	if t.Subresource != "" {
		b.WriteString("/" + t.Subresource)
	}
	return checkedPath(b.String())
}

// groupVersionPath validates apiVersion and returns the path of that group
// version: /api/<version> for the core group, /apis/<group>/<version> else.
// It is the prefix of every path target builds, and on its own the
// APIResourceList apply_manifest resolves a kind from.
func groupVersionPath(apiVersion string) (string, error) {
	group, version, grouped := strings.Cut(apiVersion, "/")
	if !grouped {
		group, version = "", apiVersion
	}
	if !kube.IsAPIVersion(version) || (grouped && !kube.IsDNS1123Subdomain(group)) {
		return "", fmt.Errorf("invalid apiVersion %q: want \"v1\" or \"<group>/<version>\" such as \"apps/v1\"", apiVersion)
	}
	if grouped {
		return "/apis/" + group + "/" + version, nil
	}
	return "/api/" + version, nil
}

// checkedPath puts a built path through gateway.CheckPath, the policy every
// upstream path of the MCP tools passes.
func checkedPath(p string) (string, error) {
	if err := gateway.CheckPath(p); err != nil {
		return "", fmt.Errorf("path not allowed: %w", err)
	}
	return p, nil
}

var errInvalidName = errors.New("invalid name")

// validName is the apiserver's own rule for a name inside a request path
// (path.ValidatePathSegmentName): not "." or "..", no "/" or "%". Names are
// deliberately not held to DNS-1123 — RBAC objects are routinely named
// "system:controller:…" — plus a length bound and no control characters. What
// remains is escaped by path(), so nothing in a name can become a query
// string or an extra segment.
func validName(name string) error {
	if name == "" || name == "." || name == ".." || len(name) > maxNameBytes ||
		strings.ContainsAny(name, `/\%`) ||
		strings.ContainsFunc(name, unicode.IsControl) {
		return fmt.Errorf("%w %q", errInvalidName, name)
	}
	return nil
}
