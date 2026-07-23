package discovery

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/n0madic/kube-console/internal/httpx"
	"github.com/n0madic/kube-console/internal/kube"
)

// statusError carries an upstream HTTP status code so the handler can forward
// an auth failure (401/403) instead of masking it as a 502. Without this a
// token that expires mid-session makes discovery answer 502, and the SPA's
// 401→logout path (api/http.ts) never fires — the sidebar just breaks. A 403
// (clusters that unbind system:discovery from system:authenticated) is an RBAC
// denial, not an unreachable apiserver, and a 502 sends the operator chasing
// network problems.
type statusError struct{ code int }

func (e *statusError) Error() string { return fmt.Sprintf("status %d", e.code) }

// Handler serves GET /api/ui/discovery. It queries the apiserver on behalf of
// the user token, prefers aggregated discovery and falls back to legacy. No
// RBAC-based filtering is applied: resources are never hidden on assumptions.
type Handler struct {
	registry *kube.Registry
	logger   *slog.Logger
}

// NewHandler builds the discovery handler.
func NewHandler(reg *kube.Registry, logger *slog.Logger) *Handler {
	return &Handler{registry: reg, logger: logger}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	token := kube.ExtractBearer(r)
	if token == "" {
		httpx.WriteError(w, http.StatusUnauthorized, "Unauthorized", "missing bearer token")
		return
	}
	up, _, ok := h.registry.ResolveRequest(w, r)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), kube.DefaultUnaryTimeout)
	defer cancel()

	resources, err := fetchAggregated(ctx, up, token)
	if err != nil {
		h.logger.Debug("aggregated discovery unavailable, falling back to legacy", "error", err)
		resources, err = fetchLegacy(ctx, up, token, h.logger)
	}
	if err != nil {
		var se *statusError
		if errors.As(err, &se) {
			switch se.code {
			case http.StatusUnauthorized:
				httpx.WriteError(w, http.StatusUnauthorized, "Unauthorized", "invalid or expired token")
				return
			case http.StatusForbidden:
				httpx.WriteError(w, http.StatusForbidden, "Forbidden", "access to API discovery is forbidden")
				return
			}
		}
		httpx.WriteError(w, http.StatusBadGateway, "ServiceUnavailable", "discovery against kube-apiserver failed")
		return
	}
	sortResources(resources)
	httpx.WriteJSON(w, http.StatusOK, Response{Resources: resources})
}
