// Package metrics implements the Metrics Server adapter: capability probing
// and normalized CPU/memory usage endpoints. Only current samples pass
// through — nothing is stored server-side.
package metrics

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/n0madic/kube-console/internal/kube"
)

const metricsGroup = "metrics.k8s.io"
const metricsGroupPath = "/apis/" + metricsGroup

// versionRe matches an API version name ("v1", "v1beta1", "v2alpha1"). It is
// the only shape allowed into the upstream path built in Handler.fetch.
var versionRe = regexp.MustCompile(`^v[0-9]+((alpha|beta)[0-9]+)?$`)

func validVersion(v string) bool { return versionRe.MatchString(v) }

// Capability states distinguished by the UI.
const (
	StateAvailable    = "available"
	StateNotInstalled = "not-installed"
	StateForbidden    = "forbidden"
	StateUnavailable  = "unavailable"
	StateDisabled     = "disabled"
)

// Capabilities is the response of GET /api/ui/metrics/capabilities.
type Capabilities struct {
	State   string `json:"state"`
	Group   string `json:"group,omitempty"`
	Version string `json:"version,omitempty"`
}

// probeCapabilities checks metrics.k8s.io availability on behalf of the user
// token. The version comes from discovery — never hardcoded. A non-nil error
// is only returned for a 401 so the caller can propagate it.
func probeCapabilities(ctx context.Context, up *kube.Upstream, token string) (Capabilities, int) {
	header := http.Header{}
	header.Set("Accept", "application/json")
	resp, err := kube.Do(ctx, up, token, http.MethodGet, metricsGroupPath, header, nil)
	if err != nil {
		return Capabilities{State: StateUnavailable}, 0
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	switch {
	case resp.StatusCode == http.StatusOK:
		var group metav1.APIGroup
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&group); err != nil {
			return Capabilities{State: StateUnavailable}, 0
		}
		// Prefer the advertised preferred version, else the first *usable* one
		// the group lists — not merely the first one, which would fail the whole
		// probe closed over a single unusable entry while a valid version sits
		// behind it.
		version := group.PreferredVersion.Version
		if !validVersion(version) {
			version = ""
			for _, v := range group.Versions {
				if validVersion(v.Version) {
					version = v.Version
					break
				}
			}
		}
		// The version is spliced straight into the upstream request path, and it
		// comes from a group an aggregated APIService owns — not from us. Anything
		// that is not a plain API version name could carry extra path structure or
		// a query string upstream, so fail closed instead.
		if !validVersion(version) {
			return Capabilities{State: StateUnavailable}, 0
		}
		return Capabilities{State: StateAvailable, Group: metricsGroup, Version: version}, 0
	case resp.StatusCode == http.StatusNotFound:
		return Capabilities{State: StateNotInstalled}, 0
	case resp.StatusCode == http.StatusForbidden:
		return Capabilities{State: StateForbidden}, 0
	case resp.StatusCode == http.StatusUnauthorized:
		return Capabilities{}, http.StatusUnauthorized
	default:
		return Capabilities{State: StateUnavailable}, 0
	}
}
