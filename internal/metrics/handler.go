package metrics

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/n0madic/kube-console/internal/httpx"
	"github.com/n0madic/kube-console/internal/kube"
)

var nameRe = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$`)

// versionCacheTTL bounds how long a resolved metrics API version is reused
// before the next capability probe.
const versionCacheTTL = 5 * time.Minute

// upstreamTimeout bounds every metrics upstream call (probe + data). A variable
// so tests can shorten it; see kube.DefaultUnaryTimeout for the rationale.
var upstreamTimeout = kube.DefaultUnaryTimeout

// cacheEntry is a resolved metrics API version for one context.
type cacheEntry struct {
	version string
	at      time.Time
}

// Handler serves the /api/ui/metrics/* endpoints.
type Handler struct {
	registry *kube.Registry
	enabled  bool

	// versionMu guards the per-context cached metrics.k8s.io version. The
	// version is a cluster-global, non-sensitive discovery result (e.g.
	// "v1beta1"); caching it per context for a short TTL avoids a capability
	// probe on every data request without mixing clusters. No metric samples,
	// per-user state or tokens are ever cached.
	versionMu sync.Mutex
	versions  map[string]cacheEntry
}

// cachedGroupVersion returns the cached metrics API version for a context, or
// "" if absent or stale.
func (h *Handler) cachedGroupVersion(context string) string {
	h.versionMu.Lock()
	defer h.versionMu.Unlock()
	entry, ok := h.versions[context]
	if !ok || entry.version == "" || time.Since(entry.at) > versionCacheTTL {
		return ""
	}
	return entry.version
}

// cacheGroupVersion stores a freshly resolved metrics API version for a context.
func (h *Handler) cacheGroupVersion(context, version string) {
	if version == "" {
		return
	}
	h.versionMu.Lock()
	defer h.versionMu.Unlock()
	h.versions[context] = cacheEntry{version: version, at: time.Now()}
}

// NewHandler builds the metrics adapter.
func NewHandler(reg *kube.Registry, enabled bool) *Handler {
	return &Handler{registry: reg, enabled: enabled, versions: map[string]cacheEntry{}}
}

// Capabilities serves GET /api/ui/metrics/capabilities.
func (h *Handler) Capabilities(w http.ResponseWriter, r *http.Request) {
	if !h.enabled {
		httpx.WriteJSON(w, http.StatusOK, Capabilities{State: StateDisabled})
		return
	}
	token := kube.ExtractBearer(r)
	if token == "" {
		httpx.WriteError(w, http.StatusUnauthorized, "Unauthorized", "missing bearer token")
		return
	}
	up, contextName, ok := h.registry.ResolveRequest(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), upstreamTimeout)
	defer cancel()
	caps, errCode := probeCapabilities(ctx, up, token)
	if errCode == http.StatusUnauthorized {
		httpx.WriteError(w, http.StatusUnauthorized, "Unauthorized", "invalid or expired token")
		return
	}
	if caps.State == StateAvailable {
		h.cacheGroupVersion(contextName, caps.Version)
	}
	httpx.WriteJSON(w, http.StatusOK, caps)
}

// Pods serves GET /api/ui/metrics/pods[?namespace=ns].
func (h *Handler) Pods(w http.ResponseWriter, r *http.Request) {
	namespace := r.URL.Query().Get("namespace")
	if namespace != "" && !nameRe.MatchString(namespace) {
		httpx.WriteError(w, http.StatusBadRequest, "BadRequest", "invalid namespace")
		return
	}
	path := "/pods"
	if namespace != "" {
		path = "/namespaces/" + url.PathEscape(namespace) + "/pods"
	}
	h.serveList(w, r, path, true)
}

// Pod serves GET /api/ui/metrics/pods/{namespace}/{name}.
func (h *Handler) Pod(w http.ResponseWriter, r *http.Request) {
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if !nameRe.MatchString(namespace) || !nameRe.MatchString(name) {
		httpx.WriteError(w, http.StatusBadRequest, "BadRequest", "invalid namespace or name")
		return
	}
	h.serveSingle(w, r, "/namespaces/"+url.PathEscape(namespace)+"/pods/"+url.PathEscape(name), true)
}

// Nodes serves GET /api/ui/metrics/nodes.
func (h *Handler) Nodes(w http.ResponseWriter, r *http.Request) {
	h.serveList(w, r, "/nodes", false)
}

// Node serves GET /api/ui/metrics/nodes/{name}.
func (h *Handler) Node(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !nameRe.MatchString(name) {
		httpx.WriteError(w, http.StatusBadRequest, "BadRequest", "invalid node name")
		return
	}
	h.serveSingle(w, r, "/nodes/"+url.PathEscape(name), false)
}

// fetch resolves the metrics API version via discovery (per request, on
// behalf of the user), then performs the metrics request. It returns the
// upstream response or writes an error/capability status itself (ok=false).
// ctx bounds the upstream calls; the caller keeps it alive until the response
// body is fully consumed.
func (h *Handler) fetch(ctx context.Context, w http.ResponseWriter, r *http.Request, subPath string) (*http.Response, bool) {
	if !h.enabled {
		httpx.WriteError(w, http.StatusNotFound, "NotFound", "metrics adapter is disabled")
		return nil, false
	}
	token := kube.ExtractBearer(r)
	if token == "" {
		httpx.WriteError(w, http.StatusUnauthorized, "Unauthorized", "missing bearer token")
		return nil, false
	}
	up, contextName, ok := h.registry.ResolveRequest(w, r)
	if !ok {
		return nil, false
	}

	// Resolve the metrics API version. A short-lived per-context cache of the
	// cluster-global version avoids a capability probe on every data request; on
	// a cache miss we probe once (which also surfaces not-installed/forbidden
	// cleanly). On a cache hit an actual not-installed/forbidden state is still
	// reflected by the data request's own status, forwarded via CopyUpstreamError.
	version := h.cachedGroupVersion(contextName)
	if version == "" {
		caps, errCode := probeCapabilities(ctx, up, token)
		if errCode == http.StatusUnauthorized {
			httpx.WriteError(w, http.StatusUnauthorized, "Unauthorized", "invalid or expired token")
			return nil, false
		}
		switch caps.State {
		case StateAvailable:
			version = caps.Version
			h.cacheGroupVersion(contextName, version)
		case StateNotInstalled:
			httpx.WriteError(w, http.StatusNotFound, "NotFound", "metrics.k8s.io is not installed")
			return nil, false
		case StateForbidden:
			httpx.WriteError(w, http.StatusForbidden, "Forbidden", "access to metrics.k8s.io is forbidden")
			return nil, false
		default:
			httpx.WriteError(w, http.StatusServiceUnavailable, "ServiceUnavailable", "metrics.k8s.io is unavailable")
			return nil, false
		}
	}

	header := http.Header{}
	header.Set("Accept", "application/json")
	resp, err := kube.Do(ctx, up, token, http.MethodGet,
		metricsGroupPath+"/"+version+subPath, header, nil)
	if err != nil {
		httpx.WriteError(w, http.StatusServiceUnavailable, "ServiceUnavailable", "metrics.k8s.io is unreachable")
		return nil, false
	}
	if resp.StatusCode != http.StatusOK {
		// Pass 403/404/503 (and anything else) through with the upstream body.
		httpx.CopyUpstreamError(w, resp)
		return nil, false
	}
	return resp, true
}

func (h *Handler) serveList(w http.ResponseWriter, r *http.Request, subPath string, pods bool) {
	ctx, cancel := context.WithTimeout(r.Context(), upstreamTimeout)
	defer cancel() // body decode below is bounded by the same deadline
	resp, ok := h.fetch(ctx, w, r, subPath)
	if !ok {
		return
	}
	defer closeBody(resp)

	// Items is initialized non-nil so an empty result serializes as "items": []
	// (matching serveSingle), never "items": null.
	out := Response{Items: []Item{}}
	var timestamps, windows []string
	if pods {
		var list struct {
			Items []podMetricsItem `json:"items"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&list); err != nil {
			httpx.WriteError(w, http.StatusBadGateway, "ServiceUnavailable", "unexpected metrics response")
			return
		}
		for _, item := range list.Items {
			out.Items = append(out.Items, normalizePod(item))
			timestamps = append(timestamps, item.Timestamp)
			windows = append(windows, item.Window)
		}
	} else {
		var list struct {
			Items []nodeMetricsItem `json:"items"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&list); err != nil {
			httpx.WriteError(w, http.StatusBadGateway, "ServiceUnavailable", "unexpected metrics response")
			return
		}
		for _, item := range list.Items {
			out.Items = append(out.Items, normalizeNode(item))
			timestamps = append(timestamps, item.Timestamp)
			windows = append(windows, item.Window)
		}
	}
	out.ObservedAt = latestTimestamp(timestamps)
	out.WindowSeconds = maxWindowSeconds(windows)
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) serveSingle(w http.ResponseWriter, r *http.Request, subPath string, pod bool) {
	ctx, cancel := context.WithTimeout(r.Context(), upstreamTimeout)
	defer cancel() // body decode below is bounded by the same deadline
	resp, ok := h.fetch(ctx, w, r, subPath)
	if !ok {
		return
	}
	defer closeBody(resp)

	var out Response
	if pod {
		var item podMetricsItem
		if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&item); err != nil {
			httpx.WriteError(w, http.StatusBadGateway, "ServiceUnavailable", "unexpected metrics response")
			return
		}
		out.Items = []Item{normalizePod(item)}
		out.ObservedAt = item.Timestamp
		out.WindowSeconds = parseWindowSeconds(item.Window)
	} else {
		var item nodeMetricsItem
		if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&item); err != nil {
			httpx.WriteError(w, http.StatusBadGateway, "ServiceUnavailable", "unexpected metrics response")
			return
		}
		out.Items = []Item{normalizeNode(item)}
		out.ObservedAt = item.Timestamp
		out.WindowSeconds = parseWindowSeconds(item.Window)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func closeBody(resp *http.Response) {
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
}
