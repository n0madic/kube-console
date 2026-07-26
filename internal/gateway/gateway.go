package gateway

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/n0madic/kube-console/internal/httpx"
	"github.com/n0madic/kube-console/internal/kube"
)

// Prefix is the URL prefix the gateway is mounted under.
const Prefix = "/k8s"

var allowedMethods = map[string]bool{
	http.MethodGet:    true,
	http.MethodHead:   true,
	http.MethodPost:   true,
	http.MethodPut:    true,
	http.MethodPatch:  true,
	http.MethodDelete: true,
}

// Gateway is the constrained reverse proxy to the kube-apiserver. It forwards
// the validated inbound Authorization header as-is over each context's shared
// credential-free transport; no token is ever stored. One ReverseProxy is
// pre-built per registered context (Transport and rewrite are fixed to a
// single upstream), and the X-Kube-Context header selects among them.
type Gateway struct {
	registry *kube.Registry
	proxies  map[string]*httputil.ReverseProxy
	logger   *slog.Logger
}

// New builds the gateway handler for /k8s/*, one reverse proxy per context.
func New(reg *kube.Registry, logger *slog.Logger) *Gateway {
	g := &Gateway{registry: reg, proxies: map[string]*httputil.ReverseProxy{}, logger: logger}
	for _, name := range reg.Names() {
		up, _ := reg.Get(name)
		g.proxies[name] = &httputil.ReverseProxy{
			Rewrite:       g.rewriteFor(up),
			Transport:     up.Transport,
			FlushInterval: -1, // flush immediately: watch/log streams
			ModifyResponse: func(resp *http.Response) error {
				resp.Header.Set("Cache-Control", "no-store")
				return nil
			},
			ErrorHandler: g.errorHandler,
		}
	}
	return g
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !allowedMethods[r.Method] {
		w.Header().Set("Allow", "GET, HEAD, POST, PUT, PATCH, DELETE")
		httpx.WriteError(w, http.StatusMethodNotAllowed, "MethodNotAllowed", "method not allowed")
		return
	}
	// The gateway never proxies protocol upgrades; exec goes through the
	// dedicated bridge only.
	if r.Header.Get("Upgrade") != "" || headerContainsToken(r.Header, "Connection", "upgrade") {
		httpx.WriteError(w, http.StatusBadRequest, "BadRequest", "protocol upgrade is not allowed on /k8s")
		return
	}
	if _, ok := g.registry.RequireToken(w, r); !ok {
		return
	}
	stripped := strings.TrimPrefix(r.URL.EscapedPath(), Prefix)
	if err := CheckPath(stripped); err != nil {
		if errors.Is(err, ErrForbiddenPath) {
			httpx.WriteError(w, http.StatusForbidden, "Forbidden", "path is not allowed through the gateway")
		} else {
			httpx.WriteError(w, http.StatusBadRequest, "BadRequest", "malformed request path")
		}
		return
	}
	// Route to the requested context's proxy. The header value is only ever a
	// registry key; an unknown name fails closed with 400 before any upstream
	// is contacted.
	_, name, ok := g.registry.ResolveRequest(w, r)
	if !ok {
		return
	}
	proxy, ok := g.proxies[name]
	if !ok {
		// Defensive: the proxies map is built from the registry's names, so a
		// resolved name always has a proxy; fail closed instead of nil-panicking
		// if that construction invariant is ever broken.
		httpx.WriteError(w, http.StatusBadRequest, "BadRequest", kube.UnknownContextMessage)
		return
	}
	proxy.ServeHTTP(w, r)
}

// rewriteFor builds a ReverseProxy Rewrite bound to a single upstream. It takes
// the upstream rather than just its base URL because the Authorization strip
// below must follow the transport this proxy actually dispatches to — reading a
// process-wide copy of the mode instead would leave the strip off for a
// credentialed upstream in any registry whose contexts disagree.
func (g *Gateway) rewriteFor(up *kube.Upstream) func(*httputil.ProxyRequest) {
	base := up.BaseURL
	return func(pr *httputil.ProxyRequest) {
		out := pr.Out

		// ReverseProxy has already stripped hop-by-hop and X-Forwarded-* headers
		// from Out; SanitizeHeaders removes cookies, impersonation, remote-user
		// and the X-Kube-Context router header. The inbound Authorization header
		// passes through untouched.
		SanitizeHeaders(out.Header)
		if up.UseConfigCredentials {
			// The upstream transport authenticates by itself here, and client-go's
			// bearer round tripper declines to overwrite an Authorization header
			// that is already set — so a client-supplied token would be forwarded
			// *instead of* the kubeconfig's credentials. Drop it: in this mode the
			// browser sends none, and one that does must not pick the identity.
			out.Header.Del("Authorization")
		}

		escaped := base.EscapedPath() + strings.TrimPrefix(pr.In.URL.EscapedPath(), Prefix)
		unescaped, err := url.PathUnescape(escaped)
		if err != nil {
			// Unreachable: CheckPath already validated every segment.
			unescaped = escaped
		}
		out.URL.Scheme = base.Scheme
		out.URL.Host = base.Host
		out.URL.Path = unescaped
		out.URL.RawPath = escaped
		// The query (watch, limit, continue, selectors, ...) passes through on
		// Out as net/http sanitized it: ReverseProxy re-encodes the inbound
		// query right before Rewrite runs, dropping semicolon-separated and
		// unparsable parameters (CVE-2022-2880). Copying pr.In's RawQuery over
		// it would restore exactly what that cleaning removed.
		// Upstream Host comes strictly from backend config, never from the client.
		out.Host = base.Host
	}
}

func (g *Gateway) errorHandler(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(context.Cause(r.Context()), httpx.ErrShutdown) {
		// AbortOnShutdown cancelled the request while the client is still
		// connected. Staying silent — as for a departed client below — would
		// let net/http complete the response as an empty 200, which a watch
		// client reads as a clean end of stream.
		httpx.WriteError(w, http.StatusServiceUnavailable, "ServiceUnavailable", "server is shutting down")
		return
	}
	if errors.Is(err, context.Canceled) {
		// Client went away; nothing to report.
		return
	}
	// errors.As alone: http.MaxBytesReader — mounted by routes.go's maxBody, and
	// the only producer of this condition — returns *http.MaxBytesError, whose
	// own Error() is the message a substring test would look for, and errors.As
	// already unwraps whatever the transport wrapped it in. A text match could
	// therefore only add false positives: an unrelated upstream error whose
	// message happens to carry that phrase would be answered 413.
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		httpx.WriteError(w, http.StatusRequestEntityTooLarge, "RequestEntityTooLarge", "request body too large")
		return
	}
	// err is safe to log here: ErrorHandler receives the transport's own error
	// (*net.OpError, x509/TLS verification, DNS, timeouts), never the
	// *url.Error wrapper http.Client adds — the one type that stringifies the
	// request URL, query included — and the sole stdlib message that echoes
	// client input (invalid upgrade protocol) is unreachable because Upgrade
	// requests are rejected before proxying. Headers and bodies never enter
	// transport errors, so only method and path may name the request.
	g.logger.Warn("gateway upstream error", "method", r.Method, "path", r.URL.Path, "error", err)
	httpx.WriteError(w, http.StatusBadGateway, "ServiceUnavailable", "upstream kube-apiserver is unreachable")
}

// IsStreaming reports whether r is a Kubernetes watch or a pod log follow
// request — the /k8s/* request shapes that can run indefinitely instead of
// returning promptly. The server uses this to abort exactly these requests on
// shutdown rather than waiting out srv.Shutdown()'s grace period, and to
// route them into the streaming in-flight pool instead of the unary one. A
// watch is either ?watch on a collection or the legacy watch prefix the
// apiserver still registers (watch forced on regardless of query), so both
// shapes must count: a stream misread as unary pins a unary slot for its
// whole lifetime and rides out the entire shutdown grace.
func IsStreaming(r *http.Request) bool {
	q := r.URL.Query()
	if apiBoolValue(q, "watch") {
		return true
	}
	if isLegacyWatchPath(strings.TrimPrefix(r.URL.Path, Prefix)) {
		return true
	}
	return strings.HasSuffix(r.URL.Path, "/log") && apiBoolValue(q, "follow")
}

// apiBoolValue decodes a boolean query parameter the way the apiserver does
// (apimachinery's Convert_Slice_string_To_bool): absent → false; present →
// true unless the first value is "0" or "false" (case-insensitive). So
// "?watch=yes", "?watch=2" and even "?watch=" — present with an empty value —
// all turn the stream on upstream, which is why presence is read off the
// values slice and never via q.Get, and why strconv.ParseBool (which rejects
// all of those) must not stand in for it.
func apiBoolValue(q url.Values, key string) bool {
	vals := q[key]
	if len(vals) == 0 {
		return false
	}
	return vals[0] != "0" && !strings.EqualFold(vals[0], "false")
}

// isLegacyWatchPath reports whether the (Prefix-stripped) path uses the
// deprecated watch prefix, which the apiserver registers with watch forced
// on: "watch" must sit exactly where that prefix puts it — segment 2 of
// /api/<version>/watch/... or segment 3 of /apis/<group>/<version>/watch/...
// — so an object literally named "watch" deeper in the path (e.g.
// /api/v1/namespaces/ns/configmaps/watch) never matches.
func isLegacyWatchPath(path string) bool {
	if path == "" || path[0] != '/' {
		return false
	}
	segments := strings.Split(path[1:], "/")
	switch segments[0] {
	case "api":
		return len(segments) > 2 && segments[2] == "watch"
	case "apis":
		return len(segments) > 3 && segments[3] == "watch"
	}
	return false
}

func headerContainsToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for _, part := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}
