package gateway

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
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
			Rewrite:       g.rewriteFor(up.BaseURL),
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
	if kube.ExtractBearer(r) == "" {
		httpx.WriteError(w, http.StatusUnauthorized, "Unauthorized", "missing bearer token")
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

// rewriteFor builds a ReverseProxy Rewrite bound to a single upstream base URL.
func (g *Gateway) rewriteFor(base *url.URL) func(*httputil.ProxyRequest) {
	return func(pr *httputil.ProxyRequest) {
		out := pr.Out

		// ReverseProxy has already stripped hop-by-hop and X-Forwarded-* headers
		// from Out; SanitizeHeaders removes cookies, impersonation, remote-user
		// and the X-Kube-Context router header. The inbound Authorization header
		// passes through untouched.
		SanitizeHeaders(out.Header)

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
		// Query string (watch, limit, continue, selectors, ...) passes through.
		out.URL.RawQuery = pr.In.URL.RawQuery
		// Upstream Host comes strictly from backend config, never from the client.
		out.Host = base.Host
	}
}

func (g *Gateway) errorHandler(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, context.Canceled) {
		// Client went away; nothing to report.
		return
	}
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) || strings.Contains(err.Error(), "request body too large") {
		httpx.WriteError(w, http.StatusRequestEntityTooLarge, "RequestEntityTooLarge", "request body too large")
		return
	}
	// Never include err details that could echo request contents; log only
	// the method and path (no query, no headers).
	g.logger.Warn("gateway upstream error", "method", r.Method, "path", r.URL.Path)
	httpx.WriteError(w, http.StatusBadGateway, "ServiceUnavailable", "upstream kube-apiserver is unreachable")
}

// IsStreaming reports whether r is a Kubernetes watch (?watch=true) or a pod
// log follow (.../log?follow=true) request — the two /k8s/* request shapes
// that can run indefinitely instead of returning promptly. The server uses
// this to abort exactly these requests on shutdown rather than waiting out
// srv.Shutdown()'s grace period, which would otherwise also delay unrelated
// short requests still in flight. Boolean parsing matches how the apiserver
// itself decodes these query params (ParseBool, not a strict "true" match).
func IsStreaming(r *http.Request) bool {
	q := r.URL.Query()
	if watch, _ := strconv.ParseBool(q.Get("watch")); watch {
		return true
	}
	if !strings.HasSuffix(r.URL.Path, "/log") {
		return false
	}
	follow, _ := strconv.ParseBool(q.Get("follow"))
	return follow
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
