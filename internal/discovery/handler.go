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

// discoveryTimeout bounds the whole discovery request; the aggregated attempt
// and the legacy fallback each get half of it. A variable so tests can
// shorten it; see kube.DefaultUnaryTimeout for the rationale.
var discoveryTimeout = kube.DefaultUnaryTimeout

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
	token, ok := h.registry.RequireToken(w, r)
	if !ok {
		return
	}
	up, _, ok := h.registry.ResolveRequest(w, r)
	if !ok {
		return
	}

	resources, err := Fetch(r.Context(), up, token, h.logger)
	if err != nil {
		switch StatusCode(err) {
		case http.StatusUnauthorized:
			httpx.WriteError(w, http.StatusUnauthorized, "Unauthorized", "invalid or expired token")
			return
		case http.StatusForbidden:
			httpx.WriteError(w, http.StatusForbidden, "Forbidden", "access to API discovery is forbidden")
			return
		}
		httpx.WriteError(w, http.StatusBadGateway, "ServiceUnavailable", "discovery against kube-apiserver failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, Response{Resources: resources})
}

// Fetch returns the cluster's resource catalog on behalf of token, sorted by
// ID and never nil. It prefers aggregated discovery and falls back to legacy;
// the HTTP handler and the MCP tools share it, so both see one catalog and one
// failure policy. An error that carries an upstream status (401, 403) reports
// it through StatusCode.
func Fetch(ctx context.Context, up *kube.Upstream, token string, logger *slog.Logger) ([]Resource, error) {
	// Each attempt gets its own half of the budget: aggregated discovery can
	// spend up to four upstream calls (two Accept variants × /apis + /api), and
	// a shared deadline handed legacy a dead context after a slow aggregated
	// probe — a 502 where legacy would have succeeded. Halving keeps the
	// combined worst case at discoveryTimeout.
	attemptTimeout := discoveryTimeout / 2

	aggCtx, aggCancel := context.WithTimeout(ctx, attemptTimeout)
	resources, err := fetchAggregated(aggCtx, up, token)
	aggCancel()
	if err != nil {
		aggErr := err
		logger.Debug("aggregated discovery unavailable, falling back to legacy", "error", aggErr)
		legCtx, legCancel := context.WithTimeout(ctx, attemptTimeout)
		defer legCancel()
		resources, err = fetchLegacy(legCtx, up, token, logger)
		if err != nil {
			// The request is about to answer an error, and the Debug line above
			// is otherwise the only record of why aggregated discovery failed.
			logger.Warn("discovery failed on both paths", "aggregated_error", aggErr, "legacy_error", err)
			// Prefer the aggregated status when legacy's own error carries
			// none: a 401/403 must not be masked as 502 by a fallback that
			// died on the network or its deadline.
			var se *statusError
			if !errors.As(err, &se) && errors.As(aggErr, &se) {
				err = aggErr
			}
		}
	}
	if err != nil {
		return nil, err
	}
	sortResources(resources)
	if resources == nil {
		// An empty catalog serializes as "resources": [], never null — the
		// same normalization nonNilVerbs applies one level down.
		resources = []Resource{}
	}
	return resources, nil
}

// StatusCode returns the upstream HTTP status carried by an error from Fetch,
// or 0 when the failure had none (network, deadline, malformed response).
func StatusCode(err error) int {
	var se *statusError
	if errors.As(err, &se) {
		return se.code
	}
	return 0
}
