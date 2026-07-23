package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/n0madic/kube-console/internal/kube"
)

// Aggregated discovery content types, newest first. Servers without support
// answer 200 with a plain APIGroupList, so the body kind must be verified.
var aggregatedAccepts = []string{
	"application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList",
	"application/json;g=apidiscovery.k8s.io;v=v2beta1;as=APIGroupDiscoveryList",
}

type aggGroupList struct {
	Kind  string     `json:"kind"`
	Items []aggGroup `json:"items"`
}

type aggGroup struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Versions []aggVersion `json:"versions"`
}

type aggVersion struct {
	Version   string        `json:"version"`
	Resources []aggResource `json:"resources"`
}

type aggResource struct {
	Resource     string `json:"resource"`
	ResponseKind struct {
		Kind string `json:"kind"`
	} `json:"responseKind"`
	Scope      string   `json:"scope"`
	Verbs      []string `json:"verbs"`
	ShortNames []string `json:"shortNames"`
	Categories []string `json:"categories"`
}

// fetchAggregated collects resources via aggregated discovery from both /apis
// and /api (the core group requires its own request). Any failure returns an
// error so the caller can fall back to legacy discovery.
func fetchAggregated(ctx context.Context, up *kube.Upstream, token string) ([]Resource, error) {
	var out []Resource
	for _, root := range []string{"/apis", "/api"} {
		list, err := fetchAggregatedRoot(ctx, up, token, root)
		if err != nil {
			return nil, fmt.Errorf("aggregated discovery %s: %w", root, err)
		}
		for _, group := range list.Items {
			for _, version := range group.Versions {
				for _, res := range version.Resources {
					if isSubresource(res.Resource) {
						continue
					}
					out = append(out, Resource{
						ID:         makeID(group.Metadata.Name, version.Version, res.Resource),
						Group:      group.Metadata.Name,
						Version:    version.Version,
						Resource:   res.Resource,
						Kind:       res.ResponseKind.Kind,
						Namespaced: res.Scope == "Namespaced",
						Verbs:      nonNilVerbs(res.Verbs),
						ShortNames: res.ShortNames,
						Categories: res.Categories,
					})
				}
			}
		}
	}
	return out, nil
}

func fetchAggregatedRoot(ctx context.Context, up *kube.Upstream, token, root string) (*aggGroupList, error) {
	var lastErr error
	for _, accept := range aggregatedAccepts {
		header := http.Header{}
		header.Set("Accept", accept)
		resp, err := kube.Do(ctx, up, token, http.MethodGet, root, header, nil)
		if err != nil {
			return nil, err
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		_ = resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			lastErr = &statusError{code: resp.StatusCode}
			continue
		}
		var list aggGroupList
		if err := json.Unmarshal(body, &list); err != nil {
			lastErr = err
			continue
		}
		if list.Kind != "APIGroupDiscoveryList" {
			lastErr = fmt.Errorf("server returned %q, not APIGroupDiscoveryList", list.Kind)
			continue
		}
		return &list, nil
	}
	return nil, lastErr
}
