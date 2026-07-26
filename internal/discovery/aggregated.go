package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"golang.org/x/sync/errgroup"

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
// and /api (the core group has no entry under /apis and needs its own request).
// Any failure returns an error so the caller can fall back to legacy discovery.
//
// The two roots are independent round trips and run concurrently: the handler
// grants this attempt only half the discovery budget so the legacy fallback
// still gets a live context, and fetchAggregatedRoot may itself try a second
// Accept variant — so serially this is a chain of up to four upstream calls
// racing a halved deadline, which is the very timeout that split exists to
// avoid. Side by side, the attempt costs one round trip's worth of latency.
//
// Each root collects into its own slice and the slices are concatenated in root
// order once the group is done, so the output stays exactly what the sequential
// version produced (everything from /apis, then everything from /api) and does
// not depend on which response lands first: sortResources sorts by ID and is not
// stable, so an arrival-ordered catalog would reshuffle entries sharing an ID
// (a resource served by both roots) from one request to the next. Appending into
// one shared slice from two goroutines would be that — and a data race besides.
func fetchAggregated(ctx context.Context, up *kube.Upstream, token string) ([]Resource, error) {
	roots := []string{"/apis", "/api"}
	perRoot := make([][]Resource, len(roots))
	eg, egCtx := errgroup.WithContext(ctx)
	for i, root := range roots {
		eg.Go(func() error {
			list, err := fetchAggregatedRoot(egCtx, up, token, root)
			if err != nil {
				// Keep naming the root: it is the whole diagnostic value of the
				// error the handler logs before falling back.
				return fmt.Errorf("aggregated discovery %s: %w", root, err)
			}
			var out []Resource
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
			perRoot[i] = out
			return nil
		})
	}
	// egCtx cancels the other root as soon as one fails, which mirrors the
	// sequential short-circuit: the attempt is doomed either way and the
	// fallback wants the budget. eg.Wait returns the first failure, so a
	// status-bearing error is not replaced by the cancellation it caused.
	if err := eg.Wait(); err != nil {
		return nil, err
	}
	var out []Resource
	for _, rs := range perRoot {
		out = append(out, rs...)
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
