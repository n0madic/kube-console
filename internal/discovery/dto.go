// Package discovery implements GET /api/ui/discovery: a normalized view of
// every discoverable top-level API resource, on behalf of the user token.
package discovery

import (
	"sort"
	"strings"
)

// Resource is the normalized discovery DTO consumed by the SPA sidebar.
type Resource struct {
	ID         string   `json:"id"`
	Group      string   `json:"group"`
	Version    string   `json:"version"`
	Resource   string   `json:"resource"`
	Kind       string   `json:"kind"`
	Namespaced bool     `json:"namespaced"`
	Verbs      []string `json:"verbs"`
	ShortNames []string `json:"shortNames,omitempty"`
	Categories []string `json:"categories,omitempty"`
}

// Response is the top-level discovery payload.
type Response struct {
	Resources []Resource `json:"resources"`
}

// makeID builds the stable resource ID; the core group is spelled "core"
// (e.g. "core/v1/pods") to keep IDs and routes unambiguous.
func makeID(group, version, resource string) string {
	if group == "" {
		group = "core"
	}
	return group + "/" + version + "/" + resource
}

// isSubresource reports whether an APIResourceList entry is a subresource
// (name contains "/", e.g. "pods/log"): those never appear in the sidebar.
func isSubresource(name string) bool {
	return strings.Contains(name, "/")
}

// nonNilVerbs normalizes a missing verbs list (nonstandard aggregated APIs
// may omit it) to an empty slice so the DTO serializes as "verbs": [] rather
// than "verbs": null, which the SPA does not expect.
func nonNilVerbs(verbs []string) []string {
	if verbs == nil {
		return []string{}
	}
	return verbs
}

// sortResources orders resources deterministically by ID.
func sortResources(rs []Resource) {
	sort.Slice(rs, func(i, j int) bool { return rs[i].ID < rs[j].ID })
}
