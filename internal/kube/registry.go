package kube

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"

	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/httpx"
)

// ContextHeader carries the selected kubeconfig context name on inbound
// requests. It is only ever a key into the upstream registry — never
// interpolated into an upstream URL — and is stripped by the gateway's
// SanitizeHeaders before any request reaches the apiserver.
const ContextHeader = "X-Kube-Context"

// ErrUnknownContext is returned by Resolve for a non-empty context name that
// has no registered upstream. Callers translate it into a 400 before any
// upstream call is made.
var ErrUnknownContext = errors.New("unknown context")

// UnknownContextMessage is the canonical 400 body message for a rejected
// X-Kube-Context value. The frontend matches this exact string to trigger its
// reset-to-default recovery (web/src/api/http.ts), so it must not be reworded
// in only one place.
const UnknownContextMessage = "unknown cluster context"

// Registry holds one credential-free Upstream per kubeconfig context. Each
// context's rest.Config is wrapped in rest.AnonymousClientConfig, so the
// zero-credential invariant holds for every cluster. It is built once at
// startup and never mutated afterwards.
type Registry struct {
	names  []string
	byName map[string]*Upstream
	def    string
}

// NewRegistry enumerates every reachable upstream and builds the shared
// credential-free transport for each. It replaces the former single
// NewRESTConfig/NewUpstream pair.
func NewRegistry(cfg *config.Config) (*Registry, error) {
	configs, defaultName, err := RESTConfigs(cfg)
	if err != nil {
		return nil, err
	}
	reg := &Registry{
		byName: make(map[string]*Upstream, len(configs)),
		def:    defaultName,
	}
	for _, nc := range configs {
		up, err := NewUpstream(nc.Config)
		if err != nil {
			// Same policy as RESTConfigs: a broken non-default context (e.g. a
			// missing CA file, only read here by TransportFor) must not sink the
			// others; a broken default is a hard error.
			if nc.Name == defaultName {
				return nil, fmt.Errorf("build upstream for default context %q: %w", nc.Name, err)
			}
			slog.Default().Warn("skipping unusable kubeconfig context", "context", nc.Name, "error", err)
			continue
		}
		reg.names = append(reg.names, nc.Name)
		reg.byName[nc.Name] = up
	}
	if _, ok := reg.byName[defaultName]; !ok {
		return nil, fmt.Errorf("default context %q has no usable upstream", defaultName)
	}
	return reg, nil
}

// NewRegistryFromUpstreams builds a registry from already-constructed
// upstreams (context name → upstream), with a stable, sorted name order. It is
// used wherever upstreams are resolved outside NewRegistry — notably tests that
// wire fake httptest upstreams. defaultName must be present in the map.
func NewRegistryFromUpstreams(defaultName string, upstreams map[string]*Upstream) *Registry {
	reg := &Registry{byName: make(map[string]*Upstream, len(upstreams)), def: defaultName}
	for name := range upstreams {
		reg.names = append(reg.names, name)
	}
	sort.Strings(reg.names)
	for name, up := range upstreams {
		reg.byName[name] = up
	}
	return reg
}

// Names returns the context names in stable order.
func (r *Registry) Names() []string { return r.names }

// DefaultName returns the resolved default context name.
func (r *Registry) DefaultName() string { return r.def }

// Default returns the default context's upstream.
func (r *Registry) Default() *Upstream { return r.byName[r.def] }

// Get returns the upstream for an exact context name.
func (r *Registry) Get(name string) (*Upstream, bool) {
	up, ok := r.byName[name]
	return up, ok
}

// Resolve maps a context-header value to an upstream. An empty value selects
// the default; an unknown non-empty value returns ErrUnknownContext. The
// returned name is the resolved context (the default's name for an empty
// value), which callers echo back to the frontend on first login.
func (r *Registry) Resolve(name string) (*Upstream, string, error) {
	if name == "" {
		return r.byName[r.def], r.def, nil
	}
	up, ok := r.byName[name]
	if !ok {
		return nil, "", ErrUnknownContext
	}
	return up, name, nil
}

// ResolveRequest resolves the request's X-Kube-Context header, writing the
// canonical 400 for an unknown name. It is the single chokepoint every HTTP
// handler uses, so the fail-closed semantics and the message the frontend
// matches on cannot drift between adapters. The boolean reports success.
func (r *Registry) ResolveRequest(w http.ResponseWriter, req *http.Request) (*Upstream, string, bool) {
	up, name, err := r.Resolve(req.Header.Get(ContextHeader))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "BadRequest", UnknownContextMessage)
		return nil, "", false
	}
	return up, name, true
}
