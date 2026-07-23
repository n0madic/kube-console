// Package config loads kube-console configuration from flags and environment
// variables. Flags take precedence over environment variables, which take
// precedence over defaults.
package config

import (
	"flag"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Env variable names. KUBE_API_SERVER and KUBE_CA_FILE are fixed by the spec;
// everything owned by kube-console itself uses the KUBE_CONSOLE_ prefix.
const (
	envAPIServer       = "KUBE_API_SERVER"
	envCAFile          = "KUBE_CA_FILE"
	envListenAddr      = "KUBE_CONSOLE_LISTEN_ADDR"
	envKubeconfig      = "KUBE_CONSOLE_KUBECONFIG"
	envKubeContext     = "KUBE_CONSOLE_KUBECONTEXT"
	envClusterName     = "KUBE_CONSOLE_CLUSTER_NAME"
	envMetricsDisable  = "KUBE_CONSOLE_METRICS_DISABLE"
	envExecDisable     = "KUBE_CONSOLE_EXEC_DISABLE"
	envMaxExecSessions = "KUBE_CONSOLE_MAX_EXEC_SESSIONS"
	envMaxExecPerIP    = "KUBE_CONSOLE_MAX_EXEC_HANDSHAKES_PER_IP"
	envAllowedOrigins  = "KUBE_CONSOLE_ALLOWED_ORIGINS"
	envMaxBodyBytes    = "KUBE_CONSOLE_MAX_BODY_BYTES"
	envRateLimit       = "KUBE_CONSOLE_RATE_LIMIT"
	envMaxInFlight     = "KUBE_CONSOLE_MAX_IN_FLIGHT"
	envTrustedProxies  = "KUBE_CONSOLE_TRUSTED_PROXIES"
	envLogLevel        = "KUBE_CONSOLE_LOG_LEVEL"
	envLogFormat       = "KUBE_CONSOLE_LOG_FORMAT"
)

// Standard in-cluster discovery inputs. When running inside a pod, kubelet
// injects the apiserver service host/port into every container, and (unless
// the projected token volume is disabled) the cluster CA is mounted at the
// well-known path below. kube-console reads only the CA — never the token.
const (
	envServiceHost  = "KUBERNETES_SERVICE_HOST"
	envServicePort  = "KUBERNETES_SERVICE_PORT"
	inClusterCAPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
)

// maxClusterNameRunes bounds Config.ClusterName: it is a page-title label, and
// a browser tab shows a couple of dozen characters at best.
const maxClusterNameRunes = 64

// RateLimitWindow is the fixed window Config.RateLimit is counted over. It is
// not configurable: one knob (requests per minute) is enough to tune, and a
// second one only makes the two easy to set inconsistently.
const RateLimitWindow = time.Minute

// caFileExists is overridable in tests; production stats the real filesystem.
var caFileExists = func(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// Config holds the full backend configuration.
type Config struct {
	ListenAddr    string
	KubeAPIServer string
	KubeCAFile    string
	// Kubeconfig enables local development mode: the file is read only for
	// the server URL and CA data; credentials are always stripped.
	Kubeconfig string
	// KubeContext selects which kubeconfig context is the default. With a
	// multi-context kubeconfig every context is still exposed for switching in
	// the UI; this only overrides which one is selected initially (instead of
	// the kubeconfig's current-context). In --api-server / in-cluster mode it
	// names the single synthesized context (defaulting to "default").
	KubeContext string
	// ClusterName is a display label for the browser page title. When set it
	// replaces the context name there for *every* context, which is the point:
	// in-cluster the single context is synthesized as "default", a name that
	// says nothing about which cluster the tab is looking at. It is purely
	// cosmetic — never a registry key, never part of a URL — and it is served
	// only to callers whose token the apiserver has accepted, like the context
	// names themselves.
	ClusterName string

	MetricsEnabled  bool
	ExecEnabled     bool
	MaxExecSessions int
	// MaxExecHandshakesPerIP bounds how many exec WebSocket connections one
	// client IP may hold *before* they authenticate. It deliberately does not
	// limit established sessions, only handshakes, which live a couple of
	// seconds at most.
	//
	// Off by default, for the same reason as RateLimit: it can only tell
	// clients apart when they actually arrive with different addresses. The
	// pending pool is bounded globally regardless, so this only decides
	// *whose* share of it one address may take.
	MaxExecHandshakesPerIP int
	// AllowedOrigins is the list of origins accepted for the exec WebSocket
	// handshake in addition to same-origin (e.g. the Vite dev server).
	AllowedOrigins []string

	// MaxBodyBytes limits request bodies forwarded to the gateway.
	MaxBodyBytes int64

	// RateLimit is the per-client request budget per RateLimitWindow for
	// /k8s/* and /api/ui/* combined. The backend forwards any request carrying
	// a bearer token to the apiserver without validating it first, so where
	// clients are distinguishable this bounds using kube-console as an
	// unmetered relay to the apiserver. 0 disables rate limiting.
	//
	// Off by default. The limit is keyed by client IP, and the deployment
	// kube-console is built for puts a perimeter in front of it — an ingress, a
	// VPN, an authenticating proxy — which is exactly what makes every user
	// arrive from one address. A shared budget then protects nothing (an
	// attacker inside the perimeter has the same key as everyone else) while
	// letting one busy tab spend the whole team's allowance and 429 the rest.
	// Turn it on where clients really do have distinct addresses: kube-console
	// published without a perimeter, or behind a proxy that forwards a
	// per-client X-Forwarded-For and whose CIDRs are named in TrustedProxies.
	// MaxInFlight is the limit that holds regardless of topology.
	RateLimit int
	// MaxInFlight caps concurrent *unary* upstream requests across all clients.
	// Watches, log follows and exec sessions get their own, much larger pool:
	// they are long-lived by design and would otherwise hold unary slots
	// forever. 0 disables both caps.
	//
	// Unlike RateLimit this is not keyed by anything the client controls or
	// shares, so it is the one abuse bound that means the same thing behind a
	// VPN, behind an ingress and on the open internet. It stays on by default.
	MaxInFlight int
	// TrustedProxies are the CIDRs of reverse proxies in front of kube-console.
	// When set, the client IP used by the IP-keyed limits is read from
	// X-Forwarded-For, skipping these hops right-to-left, and only for
	// connections that actually arrive from one of these CIDRs. When empty, the
	// client IP is the connection's RemoteAddr and X-Forwarded-For is ignored —
	// the only safe default, since the header is client-controlled and would
	// otherwise let anyone win a fresh rate-limit bucket per request.
	TrustedProxies []string

	// ReadHeaderTimeout / IdleTimeout for the HTTP server. There is
	// deliberately no WriteTimeout: it would kill watch/log streams.
	ReadHeaderTimeout time.Duration
	IdleTimeout       time.Duration
	// BodyReadTimeout bounds how long a slow client may take to send a request
	// body. It is applied per-request (via ResponseController) only to
	// body-bearing gateway methods, so watch/log response streams — which are
	// GET and never read more from the client — are never affected. Without it
	// only ReadHeaderTimeout guards the connection, leaving the body open to a
	// slowloris-style drip.
	BodyReadTimeout time.Duration
	// ResponseWriteTimeout bounds how long a single write to the client may
	// stall. It is re-armed before every write rather than set once for the
	// response, so a large download over a slow link is fine and only a client
	// that has stopped accepting data at all is dropped. This is deliberately
	// NOT an http.Server WriteTimeout: that bounds the whole response and would
	// kill watch/log streams, while an idle stream performs no write and so
	// never arms this at all. Without it a client that never reads holds its
	// in-flight slot — and its upstream connection — forever.
	ResponseWriteTimeout time.Duration
	// ExecIdleTimeout closes exec sessions with no traffic in either direction.
	ExecIdleTimeout time.Duration

	LogLevel  string // debug|info|warn|error
	LogFormat string // text|json
}

// Load parses configuration from the given command-line arguments and the
// environment.
func Load(args []string) (*Config, error) {
	metricsDisableEnv, err := envBoolOr(envMetricsDisable, false)
	if err != nil {
		return nil, err
	}
	execDisableEnv, err := envBoolOr(envExecDisable, false)
	if err != nil {
		return nil, err
	}
	maxExecSessions, err := envIntOr(envMaxExecSessions, 10)
	if err != nil {
		return nil, err
	}
	// Both IP-keyed limits default to off; see the Config fields for why a
	// shared client address makes them cost more than they buy. 240/min and 3
	// handshakes are the suggested values once clients are distinguishable.
	maxExecPerIP, err := envIntOr(envMaxExecPerIP, 0)
	if err != nil {
		return nil, err
	}
	maxBodyBytes, err := envInt64Or(envMaxBodyBytes, 4<<20) // 4 MiB
	if err != nil {
		return nil, err
	}
	rateLimit, err := envIntOr(envRateLimit, 0)
	if err != nil {
		return nil, err
	}
	maxInFlight, err := envIntOr(envMaxInFlight, 128)
	if err != nil {
		return nil, err
	}

	cfg := &Config{
		ListenAddr:             envOr(envListenAddr, ":8080"),
		KubeAPIServer:          os.Getenv(envAPIServer),
		KubeCAFile:             os.Getenv(envCAFile),
		Kubeconfig:             os.Getenv(envKubeconfig),
		KubeContext:            os.Getenv(envKubeContext),
		ClusterName:            os.Getenv(envClusterName),
		MetricsEnabled:         !metricsDisableEnv,
		ExecEnabled:            !execDisableEnv,
		MaxExecSessions:        maxExecSessions,
		MaxExecHandshakesPerIP: maxExecPerIP,
		AllowedOrigins:         splitCSV(os.Getenv(envAllowedOrigins)),
		MaxBodyBytes:           maxBodyBytes,
		RateLimit:              rateLimit,
		MaxInFlight:            maxInFlight,
		TrustedProxies:         splitCSV(os.Getenv(envTrustedProxies)),
		ReadHeaderTimeout:      10 * time.Second,
		IdleTimeout:            2 * time.Minute,
		BodyReadTimeout:        30 * time.Second,
		ResponseWriteTimeout:   30 * time.Second,
		ExecIdleTimeout:        15 * time.Minute,
		LogLevel:               envOr(envLogLevel, "info"),
		LogFormat:              envOr(envLogFormat, "text"),
	}

	fs := flag.NewFlagSet("kube-console", flag.ContinueOnError)
	fs.StringVar(&cfg.ListenAddr, "listen", cfg.ListenAddr, "listen address")
	fs.StringVar(&cfg.KubeAPIServer, "api-server", cfg.KubeAPIServer, "kube-apiserver base URL (e.g. https://kubernetes.default.svc)")
	fs.StringVar(&cfg.KubeCAFile, "ca-file", cfg.KubeCAFile, "path to the kube-apiserver CA certificate")
	fs.StringVar(&cfg.Kubeconfig, "kubeconfig", cfg.Kubeconfig, "development only: kubeconfig for server URL/CA; credentials are stripped")
	fs.StringVar(&cfg.KubeContext, "context", cfg.KubeContext, "default kubeconfig context (overrides current-context); every context stays switchable in the UI")
	fs.StringVar(&cfg.ClusterName, "cluster-name", cfg.ClusterName, "display name of the cluster shown in the browser page title; overrides the context name for every context")
	metricsDisable := fs.Bool("metrics-disable", !cfg.MetricsEnabled, "disable the Metrics Server adapter")
	execDisable := fs.Bool("exec-disable", !cfg.ExecEnabled, "disable the exec WebSocket bridge")
	fs.IntVar(&cfg.MaxExecSessions, "max-exec-sessions", cfg.MaxExecSessions, "maximum concurrent exec sessions")
	fs.IntVar(&cfg.MaxExecHandshakesPerIP, "max-exec-handshakes-per-ip", cfg.MaxExecHandshakesPerIP, "maximum unauthenticated exec WebSocket connections per client IP; 0 (default) disables, meaningful only when clients have distinct addresses")
	origins := fs.String("allowed-origins", strings.Join(cfg.AllowedOrigins, ","), "comma-separated extra allowed origins for the exec WebSocket")
	fs.Int64Var(&cfg.MaxBodyBytes, "max-body-bytes", cfg.MaxBodyBytes, "maximum request body size for /k8s/*")
	fs.IntVar(&cfg.RateLimit, "rate-limit", cfg.RateLimit, "per-client requests per minute for /k8s/* and /api/ui/*; 0 (default) disables, meaningful only when clients have distinct addresses")
	fs.IntVar(&cfg.MaxInFlight, "max-in-flight", cfg.MaxInFlight, "maximum concurrent non-streaming upstream requests; streams get a pool 8x this size (0 disables both)")
	proxies := fs.String("trusted-proxies", strings.Join(cfg.TrustedProxies, ","), "comma-separated CIDRs of reverse proxies whose X-Forwarded-For may be trusted for the client IP")
	fs.StringVar(&cfg.LogLevel, "log-level", cfg.LogLevel, "log level: debug|info|warn|error")
	fs.StringVar(&cfg.LogFormat, "log-format", cfg.LogFormat, "log format: text|json")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	cfg.AllowedOrigins = splitCSV(*origins)
	cfg.TrustedProxies = splitCSV(*proxies)
	cfg.MetricsEnabled = !*metricsDisable
	cfg.ExecEnabled = !*execDisable
	cfg.ClusterName = strings.TrimSpace(cfg.ClusterName)

	cfg.applyInClusterDefaults()

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// applyInClusterDefaults fills the apiserver URL and CA from standard
// in-cluster inputs when nothing more specific was configured. It only runs
// when neither an explicit --api-server nor a --kubeconfig is set, so it never
// overrides an operator's choice, and it reads only the public cluster CA —
// never any ServiceAccount token.
func (c *Config) applyInClusterDefaults() {
	if c.KubeAPIServer != "" || c.Kubeconfig != "" {
		return
	}
	host, port := os.Getenv(envServiceHost), os.Getenv(envServicePort)
	if host == "" || port == "" {
		return
	}
	c.KubeAPIServer = "https://" + net.JoinHostPort(host, port)
	if c.KubeCAFile == "" && caFileExists(inClusterCAPath) {
		c.KubeCAFile = inClusterCAPath
	}
}

func (c *Config) validate() error {
	// No api-server/kubeconfig requirement here: when both are empty the
	// backend falls back to standard $KUBECONFIG / ~/.kube/config discovery in
	// kube.RESTConfigs, which reports a clear error if nothing resolves.
	if c.MaxExecSessions < 1 {
		return fmt.Errorf("max exec sessions must be >= 1, got %d", c.MaxExecSessions)
	}
	if c.MaxBodyBytes < 1 {
		return fmt.Errorf("max body bytes must be >= 1, got %d", c.MaxBodyBytes)
	}
	if c.MaxExecHandshakesPerIP < 0 {
		return fmt.Errorf("max exec handshakes per IP must be >= 0, got %d", c.MaxExecHandshakesPerIP)
	}
	if c.RateLimit < 0 {
		return fmt.Errorf("rate limit must be >= 0, got %d", c.RateLimit)
	}
	if c.MaxInFlight < 0 {
		return fmt.Errorf("max in-flight must be >= 0, got %d", c.MaxInFlight)
	}
	// The cluster name is rendered into document.title. The SPA assigns it as
	// text (no markup path), so this is not an escaping guard — it keeps a
	// mistyped value from producing a title with line breaks or NULs in it,
	// and bounds what a tab has to show.
	if n := utf8.RuneCountInString(c.ClusterName); n > maxClusterNameRunes {
		return fmt.Errorf("cluster name must be at most %d characters, got %d", maxClusterNameRunes, n)
	}
	for _, r := range c.ClusterName {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("cluster name must not contain control characters, got %q", c.ClusterName)
		}
	}
	// Parsed here rather than at router construction: chi's ClientIPFromXFF
	// panics on a bad prefix, and a typo in a flag must be a startup error.
	for _, p := range c.TrustedProxies {
		if _, err := netip.ParsePrefix(p); err != nil {
			return fmt.Errorf("invalid trusted proxy CIDR %q: %w", p, err)
		}
	}
	return nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBoolOr(key string, def bool) (bool, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("invalid %s=%q: must be a boolean", key, v)
	}
	return b, nil
}

func envIntOr(key string, def int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("invalid %s=%q: must be an integer", key, v)
	}
	return n, nil
}

func envInt64Or(key string, def int64) (int64, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid %s=%q: must be an integer", key, v)
	}
	return n, nil
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
