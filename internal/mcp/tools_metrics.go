package mcp

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/n0madic/kube-console/internal/kube"
	"github.com/n0madic/kube-console/internal/metrics"
)

const (
	defaultTopLimit = 20
	maxTopLimit     = 200
)

// registerMetricsTools adds top when the metrics adapter is enabled. It goes
// through the same metrics.Handler as /api/ui/metrics, so the per-context
// metrics.k8s.io version cache and its eviction rules are shared, not copied.
func (s *server) registerMetricsTools(srv *sdk.Server) {
	if s.metrics == nil {
		return
	}
	addTool(s, srv, &sdk.Tool{
		Name: "top",
		Description: "Show current CPU and memory usage of pods or nodes from metrics.k8s.io, like `kubectl top`, " +
			"highest first. Name one pod to get its per-container usage. Requires metrics-server in the cluster.",
		Annotations: readOnly("Top"),
	}, s.top)
}

type topIn struct {
	Kind      string `json:"kind" jsonschema:"pods or nodes"`
	Namespace string `json:"namespace,omitempty" jsonschema:"pods only: the namespace; omit for all namespaces"`
	Name      string `json:"name,omitempty" jsonschema:"one pod (requires namespace) or one node"`
	SortBy    string `json:"sortBy,omitempty" jsonschema:"cpu (the default) or memory"`
	Limit     int    `json:"limit,omitempty" jsonschema:"maximum number of items to return; default 20, at most 200"`
}

type topContainer struct {
	Name          string `json:"name"`
	CPUMillicores int64  `json:"cpuMillicores"`
	MemoryMiB     int64  `json:"memoryMiB"`
}

type topItem struct {
	Namespace     string `json:"namespace,omitempty"`
	Name          string `json:"name"`
	CPUMillicores int64  `json:"cpuMillicores"`
	MemoryMiB     int64  `json:"memoryMiB"`
	// Containers is filled only when one pod is named.
	Containers []topContainer `json:"containers,omitempty"`
}

type topOut struct {
	// ObservedAt is the newest sample's timestamp as metrics-server reports it.
	ObservedAt    string `json:"observedAt"`
	WindowSeconds int64  `json:"windowSeconds"`
	// Total is the number of items before limit was applied.
	Total int       `json:"total"`
	Items []topItem `json:"items"`
}

func (s *server) top(ctx context.Context, c caller, in topIn) (topOut, error) {
	pods := in.Kind == "pods"
	if !pods && in.Kind != "nodes" {
		return topOut{}, errors.New("kind must be pods or nodes")
	}
	byMemory := false
	switch in.SortBy {
	case "", "cpu":
	case "memory":
		byMemory = true
	default:
		return topOut{}, errors.New("sortBy must be cpu or memory")
	}
	if in.Namespace != "" && (!pods || !kube.IsDNS1123Label(in.Namespace)) {
		return topOut{}, errors.New("namespace must be a valid namespace name, and only with kind pods")
	}
	if in.Name != "" && !kube.IsDNS1123Subdomain(in.Name) {
		return topOut{}, errors.New("invalid name")
	}
	if pods && in.Name != "" && in.Namespace == "" {
		return topOut{}, errors.New("a pod name requires its namespace")
	}

	// Every segment was validated above and is escaped regardless; the
	// metrics core prefixes the group version itself.
	subPath := "/nodes"
	if pods {
		subPath = "/pods"
		if in.Namespace != "" {
			subPath = "/namespaces/" + url.PathEscape(in.Namespace) + "/pods"
		}
	}
	var (
		resp metrics.Response
		err  error
	)
	if in.Name != "" {
		resp, err = s.metrics.Get(ctx, c.up, c.context, c.token, subPath+"/"+url.PathEscape(in.Name), pods)
	} else {
		resp, err = s.metrics.List(ctx, c.up, c.context, c.token, subPath, pods)
	}
	if err != nil {
		return topOut{}, metricsError(err, c.token)
	}

	items := make([]topItem, 0, len(resp.Items))
	for _, it := range resp.Items {
		item := topItem{
			Namespace:     it.Namespace,
			Name:          it.Name,
			CPUMillicores: millicores(it.CPUNanoCores),
			MemoryMiB:     mebibytes(it.MemoryBytes),
		}
		if in.Name != "" && pods {
			item.Containers = make([]topContainer, 0, len(it.Containers))
			for _, cu := range it.Containers {
				item.Containers = append(item.Containers, topContainer{
					Name:          cu.Name,
					CPUMillicores: millicores(cu.CPUNanoCores),
					MemoryMiB:     mebibytes(cu.MemoryBytes),
				})
			}
		}
		items = append(items, item)
	}
	// Sorted on the exact values, not the rounded ones shown.
	key := func(i int) int64 { return resp.Items[i].CPUNanoCores }
	if byMemory {
		key = func(i int) int64 { return resp.Items[i].MemoryBytes }
	}
	order := make([]int, len(items))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool {
		ka, kb := key(order[a]), key(order[b])
		if ka != kb {
			return ka > kb
		}
		ia, ib := items[order[a]], items[order[b]]
		if ia.Namespace != ib.Namespace {
			return ia.Namespace < ib.Namespace
		}
		return ia.Name < ib.Name
	})
	out := topOut{ObservedAt: resp.ObservedAt, WindowSeconds: resp.WindowSeconds, Total: len(items), Items: []topItem{}}
	for _, i := range order[:min(len(order), clamp(in.Limit, defaultTopLimit, maxTopLimit))] {
		out.Items = append(out.Items, items[i])
	}
	return out, nil
}

// metricsError maps a metrics core error onto the tool's upstream error shape,
// scrubbing the caller's token from the text like statusError does.
func metricsError(err error, token string) error {
	var me *metrics.Error
	if !errors.As(err, &me) {
		return errors.New("metrics request failed")
	}
	return &upstreamError{code: me.Code, reason: http.StatusText(me.Code), message: scrub(strings.TrimSpace(me.Text()), token)}
}

func millicores(nano int64) int64 { return (nano + 500_000) / 1_000_000 }

func mebibytes(b int64) int64 { return (b + 1<<19) >> 20 }
