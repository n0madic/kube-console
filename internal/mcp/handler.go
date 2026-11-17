// Package mcp serves the Model Context Protocol endpoint (/mcp) that lets an AI
// agent use kube-console the way the SPA does: with its own Kubernetes bearer
// token, forwarded per request, and nothing held by the backend in between.
//
// The endpoint speaks protocol revision 2026-07-28 only, which is stateless:
// no initialize handshake, no Mcp-Session-Id, no GET stream. Every call is one
// POST carrying everything it needs, so the endpoint keeps the backend
// stateless exactly as the rest of it is.
//
// Two rules carry the security model and must not be relaxed:
//
//   - The cluster and the credential come from HTTP headers (X-Kube-Context,
//     Authorization), never from tool arguments. One MCP client entry is one
//     (cluster, token) pair, so text the model reads — a log line, an
//     annotation — cannot steer a call to another cluster, and the token never
//     enters the model's context or a tool argument that could be logged.
//   - Any request carrying an Origin header is refused. Agents send none; a
//     browser always does on a POST, so this is the DNS-rebinding defence the
//     specification requires, and stricter than a same-origin check.
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/n0madic/kube-console/internal/auth"
	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/httpx"
	"github.com/n0madic/kube-console/internal/kube"
	"github.com/n0madic/kube-console/internal/metrics"
)

// ProtocolVersion is the only MCP revision served. Older revisions need the
// initialize handshake and a session, which this endpoint deliberately lacks.
const ProtocolVersion = "2026-07-28"

// protocolVersionHeader carries the revision on every 2026-07-28 POST.
const protocolVersionHeader = "MCP-Protocol-Version"

// instructions is sent to clients as ServerOptions.Instructions: the few
// conventions a model needs before its first call.
const instructions = `kube-console exposes one Kubernetes cluster, fixed by this connection; ` +
	`there is no tool argument to pick another one. Calls run with the connection's own ` +
	`Kubernetes credentials, so RBAC decides what succeeds. Call whoami to see the identity ` +
	`and the cluster context in use.`

// Options configures NewHandler.
type Options struct {
	Registry *kube.Registry
	// Mode is config.MCPRead or config.MCPWrite; config.MCPOff never reaches
	// here (the route is not mounted). It decides which tools are registered.
	Mode    string
	Version string
	// MaxBodyBytes caps a request body, as it does for /k8s/*.
	MaxBodyBytes int64
	Logger       *slog.Logger
	// Metrics is the metrics adapter shared with /api/ui/metrics (one
	// version cache per context). nil — the adapter is disabled — leaves the
	// top tool unregistered.
	Metrics *metrics.Handler
}

type server struct {
	reg       *kube.Registry
	metrics   *metrics.Handler
	mode      string
	userAgent string
	logger    *slog.Logger
}

// NewHandler builds the /mcp handler: the guards below, then the SDK's
// stateless Streamable HTTP transport.
func NewHandler(o Options) http.Handler {
	s := &server{
		reg:       o.Registry,
		metrics:   o.Metrics,
		mode:      o.Mode,
		userAgent: "kube-console-mcp/" + o.Version,
		logger:    o.Logger,
	}
	sdkLogger := slog.New(demoteInfo{o.Logger.Handler()}).With("component", "mcp")
	srv := sdk.NewServer(&sdk.Implementation{Name: "kube-console", Version: o.Version}, &sdk.ServerOptions{
		Instructions:              instructions,
		SupportedProtocolVersions: []string{ProtocolVersion},
		Logger:                    sdkLogger,
	})
	s.registerTools(srv)
	h := sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return srv }, &sdk.StreamableHTTPOptions{
		Stateless:           true,
		JSONResponse:        true,
		MaxRequestBodyBytes: o.MaxBodyBytes,
		Logger:              sdkLogger,
	})
	return s.guard(h)
}

// guard runs ahead of the SDK and answers everything that needs no protocol
// parsing: a browser origin, a method other than POST, a missing bearer and an
// unknown cluster context. Failing those here, as plain HTTP statuses, keeps
// them uniform with the rest of the backend and keeps a request that can never
// succeed from reaching the JSON-RPC layer at all.
func (s *server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" {
			httpx.WriteError(w, http.StatusForbidden, "Forbidden",
				"browser requests are not accepted on the MCP endpoint")
			return
		}
		if r.Method != http.MethodPost {
			// The 2026-07-28 transport has no GET stream and no session to
			// DELETE. Answered here so an unauthenticated GET gets the same 405
			// an authenticated one would, not a 401 that suggests a token helps.
			w.Header().Set("Allow", http.MethodPost)
			httpx.WriteError(w, http.StatusMethodNotAllowed, "MethodNotAllowed", "method not allowed")
			return
		}
		// The SDK's own version gate is not enough: in stateless mode a request
		// with no MCP-Protocol-Version and no _meta is read as 2025-03-26 and
		// served on a synthesized session whatever SupportedProtocolVersions
		// says — batches included, i.e. several tool calls behind one in-flight
		// slot. 2026-07-28 makes the header mandatory on every POST, so require
		// it exactly; the SDK then checks it against the body's _meta.
		if r.Header.Get(protocolVersionHeader) != ProtocolVersion {
			httpx.WriteError(w, http.StatusBadRequest, "BadRequest",
				"unsupported or missing "+protocolVersionHeader+": this endpoint serves MCP "+ProtocolVersion+" only")
			return
		}
		if !s.reg.UsesConfigCredentials() && kube.ExtractBearer(r) == "" {
			// RFC 6750: a 401 names the scheme it wants. Without
			// resource_metadata, since there is no authorization server.
			w.Header().Set("WWW-Authenticate", `Bearer realm="kube-console"`)
		}
		if _, ok := s.reg.RequireToken(w, r); !ok {
			return
		}
		if _, _, ok := s.reg.ResolveRequest(w, r); !ok {
			return
		}
		next.ServeHTTP(w, r)
	})
}

// caller is who a tool call speaks for and where it goes.
type caller struct {
	up      *kube.Upstream
	context string
	token   string
}

var errMissingToken = errors.New("missing bearer token")

// callerFrom resolves the caller from the request's own headers. guard has
// already checked both on the way in; they are read again here because the
// SDK hands a tool handler the request headers, not anything guard computed,
// and re-resolving costs a map lookup.
func (s *server) callerFrom(req *sdk.CallToolRequest) (caller, error) {
	var h http.Header
	if req != nil && req.Extra != nil {
		h = req.Extra.Header
	}
	up, name, err := s.reg.Resolve(h.Get(kube.ContextHeader))
	if err != nil {
		return caller{}, errors.New(kube.UnknownContextMessage)
	}
	token := ""
	if !s.reg.UsesConfigCredentials() {
		if token = kube.BearerFromHeader(h); token == "" {
			return caller{}, errMissingToken
		}
	}
	return caller{up: withUserAgent(up, s.userAgent), context: name, token: token}, nil
}

// run resolves the caller, bounds the call and logs one line for it. The line
// carries the tool, the context, the outcome class and the duration — never the
// arguments (a manifest may hold Secret data) and never the error text (it may
// quote object contents).
func run[R any](ctx context.Context, s *server, tool string, req *sdk.CallToolRequest, h func(context.Context, caller) (R, error)) (R, error) {
	start := time.Now()
	var zero R
	c, err := s.callerFrom(req)
	if err != nil {
		s.logCall(tool, "", "rejected", start)
		return zero, err
	}
	ctx, cancel := context.WithTimeout(ctx, kube.DefaultUnaryTimeout)
	defer cancel()
	r, err := h(ctx, c)
	s.logCall(tool, c.context, outcome(err), start)
	if err != nil {
		return zero, err
	}
	return r, nil
}

// addTool registers a tool with a typed, structured result. Every result is
// held to maxOutputBytes here, in one place: what a tool reads is bounded by
// its own read limit, but a projection of a 16 MiB list page is not, and the
// result lands in a model's context window.
func addTool[In, Out any](s *server, srv *sdk.Server, t *sdk.Tool, h func(context.Context, caller, In) (Out, error)) {
	sdk.AddTool(srv, t, func(ctx context.Context, req *sdk.CallToolRequest, in In) (*sdk.CallToolResult, Out, error) {
		out, err := run(ctx, s, t.Name, req, func(ctx context.Context, c caller) (Out, error) {
			out, err := h(ctx, c, in)
			if err != nil {
				return out, err
			}
			if b, err := json.Marshal(out); err == nil && len(b) > maxOutputBytes {
				var zero Out
				return zero, errTooLarge{limit: maxOutputBytes}
			}
			return out, nil
		})
		return nil, out, err
	})
}

// addTextTool registers a tool whose result is plain text — a YAML manifest, a
// log — which a model reads far better as text than as a JSON-escaped string
// inside structured content. It has no output schema; the result is held to
// maxOutputBytes like addTool's.
func addTextTool[In any](s *server, srv *sdk.Server, t *sdk.Tool, h func(context.Context, caller, In) (string, error)) {
	sdk.AddTool(srv, t, func(ctx context.Context, req *sdk.CallToolRequest, in In) (*sdk.CallToolResult, any, error) {
		text, err := run(ctx, s, t.Name, req, func(ctx context.Context, c caller) (string, error) {
			text, err := h(ctx, c, in)
			if err == nil && len(text) > maxOutputBytes {
				return "", errTooLarge{limit: maxOutputBytes}
			}
			return text, err
		})
		if err != nil {
			return nil, nil, err
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, nil, nil
	})
}

func (s *server) logCall(tool, context, outcome string, start time.Time) {
	s.logger.Info("mcp tool",
		"tool", tool,
		"context", context,
		"outcome", outcome,
		"duration", time.Since(start).Round(time.Millisecond).String(),
	)
}

// registerTools adds the tool set for the configured mode. Write tools are
// registered only in write mode, so a read-mode tools/list never names them.
func (s *server) registerTools(srv *sdk.Server) {
	addTool(s, srv, &sdk.Tool{
		Name:        "whoami",
		Description: "Return the Kubernetes identity this connection acts as and the cluster context it is bound to.",
		Annotations: readOnly("Who am I"),
	}, s.whoami)
	s.registerReadTools(srv)
	s.registerMetricsTools(srv)
	if s.mode == config.MCPWrite {
		s.registerWriteTools(srv)
	}
}

func readOnly(title string) *sdk.ToolAnnotations {
	return &sdk.ToolAnnotations{Title: title, ReadOnlyHint: true, IdempotentHint: true}
}

type whoamiIn struct{}

type whoamiOut struct {
	Context  string   `json:"context" jsonschema:"the kube-console cluster context this connection is bound to"`
	Username string   `json:"username,omitempty" jsonschema:"the authenticated Kubernetes user name"`
	UID      string   `json:"uid,omitempty" jsonschema:"the authenticated user's UID"`
	Groups   []string `json:"groups,omitempty" jsonschema:"the groups the user belongs to"`
	// IdentityUnavailable: the token is valid but RBAC forbids reading it.
	IdentityUnavailable bool `json:"identityUnavailable,omitempty" jsonschema:"true when the credentials are valid but may not introspect themselves"`
}

func (s *server) whoami(ctx context.Context, c caller, _ whoamiIn) (whoamiOut, error) {
	v, err := auth.VerifyToken(ctx, c.up, c.token)
	if err != nil {
		// Only the sentinel: VerifyToken wraps the transport error, which names
		// the apiserver URL, and upstream addresses are never shown to clients.
		if errors.Is(err, auth.ErrInvalidToken) {
			return whoamiOut{}, auth.ErrInvalidToken
		}
		return whoamiOut{}, auth.ErrUpstream
	}
	out := whoamiOut{Context: c.context, IdentityUnavailable: v.IdentityUnavailable}
	if v.Identity != nil {
		out.Username = v.Identity.Username
		out.UID = v.Identity.UID
		out.Groups = v.Identity.Groups
	}
	return out, nil
}

// userAgentTransport stamps the agent's User-Agent on every upstream request,
// so the apiserver's audit log can tell an agent's calls from the SPA's.
type userAgentTransport struct {
	base http.RoundTripper
	ua   string
}

func (u userAgentTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.Header.Set("User-Agent", u.ua)
	return u.base.RoundTrip(clone)
}

// withUserAgent returns a per-call copy of up whose transport sets the agent
// User-Agent. A copy rather than a wrapper around kube.Do so that every helper
// taking an *Upstream (auth.VerifyToken, discovery) inherits it unchanged; the
// shared upstream itself is never mutated.
func withUserAgent(up *kube.Upstream, ua string) *kube.Upstream {
	cp := *up
	cp.Transport = userAgentTransport{base: up.Transport, ua: ua}
	return &cp
}

// demoteInfo is the SDK's log handler: it narrates every stateless request at
// Info ("server connecting", "server session connected", "… disconnected") —
// three lines per tool call that say nothing the request log and the
// "mcp tool" line do not. Below Warn is demoted to Debug; Warn and Error pass.
type demoteInfo struct{ h slog.Handler }

func (d demoteInfo) Enabled(ctx context.Context, l slog.Level) bool {
	return d.h.Enabled(ctx, demoted(l))
}

func (d demoteInfo) Handle(ctx context.Context, r slog.Record) error {
	r.Level = demoted(r.Level)
	return d.h.Handle(ctx, r)
}

func (d demoteInfo) WithAttrs(attrs []slog.Attr) slog.Handler {
	return demoteInfo{d.h.WithAttrs(attrs)}
}

func (d demoteInfo) WithGroup(name string) slog.Handler { return demoteInfo{d.h.WithGroup(name)} }

func demoted(l slog.Level) slog.Level {
	if l < slog.LevelWarn {
		return slog.LevelDebug
	}
	return l
}
