package server

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/n0madic/kube-console/internal/auth"
	"github.com/n0madic/kube-console/internal/discovery"
	execbridge "github.com/n0madic/kube-console/internal/exec"
	"github.com/n0madic/kube-console/internal/httpx"
	"github.com/n0madic/kube-console/internal/kube"
	"github.com/n0madic/kube-console/internal/metrics"
)

// execWSRoute is the exec bridge's path within the /api/ui router; execWSPath
// is the same route as the limiters downstream see it (isExecWS). Declared once
// so moving the route cannot silently detach the exemption from it.
const (
	execWSRoute = "/exec/ws"
	execWSPath  = "/api/ui" + execWSRoute
)

// registerUI mounts the /api/ui/* adapter endpoints (contexts, auth verify,
// discovery, metrics, exec). Every adapter resolves the target cluster from the
// X-Kube-Context header per request via the shared registry.
func registerUI(ui chi.Router, d Deps) {
	ui.Method("GET", "/contexts", handleContexts(d.Registry, d.Cfg.ClusterName, d.Logger))
	ui.Method("POST", "/auth/verify", auth.NewHandler(d.Registry, d.Logger))
	ui.Method("GET", "/discovery", discovery.NewHandler(d.Registry, d.Logger))

	m := metrics.NewHandler(d.Registry, d.Cfg.MetricsEnabled)
	ui.Get("/metrics/capabilities", m.Capabilities)
	ui.Get("/metrics/pods", m.Pods)
	ui.Get("/metrics/pods/{namespace}/{name}", m.Pod)
	ui.Get("/metrics/nodes", m.Nodes)
	ui.Get("/metrics/nodes/{name}", m.Node)

	ui.Method("GET", execWSRoute, AbortOnShutdown(d.ShutdownCtx, nil)(execbridge.NewHandler(d.Registry, d.Cfg, d.Logger)))
}

type contextEntry struct {
	Name string `json:"name"`
}

type contextsResponse struct {
	Contexts []contextEntry `json:"contexts"`
	Default  string         `json:"default"`
	// ClusterName is the operator-configured page-title label, empty unless
	// --cluster-name is set. It rides on this endpoint rather than on a public
	// one because a cluster label describes the estate exactly like the context
	// names next to it, and this response is already gated on a token the
	// apiserver accepted.
	ClusterName string `json:"clusterName,omitempty"`
}

// handleContexts serves GET /api/ui/contexts: the kubeconfig context names and
// the default. Server URLs and CAs are never exposed, but the names themselves
// describe the estate (environments, cloud account identifiers in EKS-style
// context names), so the token is verified against the apiserver before they
// are returned — presence of an Authorization header proves nothing, and this
// endpoint would otherwise hand the topology to anyone who sends the word
// "Bearer". It costs one SelfSubjectReview per fetch, and the SPA fetches this
// once per session (staleTime 5m).
func handleContexts(reg *kube.Registry, clusterName string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := kube.ExtractBearer(r)
		if token == "" {
			httpx.WriteError(w, http.StatusUnauthorized, "Unauthorized", "missing bearer token")
			return
		}
		up, contextName, ok := reg.ResolveRequest(w, r)
		if !ok {
			return
		}
		if _, err := auth.VerifyToken(r.Context(), up, token); err != nil {
			auth.LogAndWriteError(w, logger, contextName, err)
			return
		}
		names := reg.Names()
		entries := make([]contextEntry, 0, len(names))
		for _, name := range names {
			entries = append(entries, contextEntry{Name: name})
		}
		httpx.WriteJSON(w, http.StatusOK, contextsResponse{
			Contexts:    entries,
			Default:     reg.DefaultName(),
			ClusterName: clusterName,
		})
	}
}
