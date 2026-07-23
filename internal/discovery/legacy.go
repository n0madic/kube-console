package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"

	"golang.org/x/sync/errgroup"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/n0madic/kube-console/internal/kube"
)

// fetchLegacy collects resources via classic discovery: /api, /apis, then one
// APIResourceList request per group-version. Unreachable or broken groups are
// skipped so a single misbehaving aggregated API cannot break the sidebar.
func fetchLegacy(ctx context.Context, up *kube.Upstream, token string, logger *slog.Logger) ([]Resource, error) {
	var groupVersions []gvRef

	var core metav1.APIVersions
	if err := getJSON(ctx, up, token, "/api", &core); err != nil {
		return nil, fmt.Errorf("legacy discovery /api: %w", err)
	}
	for _, v := range core.Versions {
		groupVersions = append(groupVersions, gvRef{group: "", version: v, path: "/api/" + v})
	}

	var groups metav1.APIGroupList
	if err := getJSON(ctx, up, token, "/apis", &groups); err != nil {
		return nil, fmt.Errorf("legacy discovery /apis: %w", err)
	}
	for _, g := range groups.Groups {
		for _, gv := range g.Versions {
			groupVersions = append(groupVersions, gvRef{
				group:   g.Name,
				version: gv.Version,
				path:    "/apis/" + g.Name + "/" + gv.Version,
			})
		}
	}

	var (
		mu  sync.Mutex
		out []Resource
	)
	eg, egCtx := errgroup.WithContext(ctx)
	eg.SetLimit(8)
	for _, gv := range groupVersions {
		eg.Go(func() error {
			var list metav1.APIResourceList
			if err := getJSON(egCtx, up, token, gv.path, &list); err != nil {
				logger.Warn("skipping unavailable API group version", "path", gv.path, "error", err)
				return nil
			}
			mu.Lock()
			defer mu.Unlock()
			for _, res := range list.APIResources {
				if isSubresource(res.Name) {
					continue
				}
				out = append(out, Resource{
					ID:         makeID(gv.group, gv.version, res.Name),
					Group:      gv.group,
					Version:    gv.version,
					Resource:   res.Name,
					Kind:       res.Kind,
					Namespaced: res.Namespaced,
					Verbs:      nonNilVerbs(res.Verbs),
					ShortNames: res.ShortNames,
					Categories: res.Categories,
				})
			}
			return nil
		})
	}
	if err := eg.Wait(); err != nil {
		return nil, err
	}
	return out, nil
}

type gvRef struct {
	group   string
	version string
	path    string
}

func getJSON(ctx context.Context, up *kube.Upstream, token, path string, v any) error {
	header := http.Header{}
	header.Set("Accept", "application/json")
	resp, err := kube.Do(ctx, up, token, http.MethodGet, path, header, nil)
	if err != nil {
		return err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()
	if resp.StatusCode != http.StatusOK {
		return &statusError{code: resp.StatusCode}
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(v)
}
