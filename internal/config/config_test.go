package config

import (
	"strings"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("KUBE_API_SERVER", "https://kubernetes.default.svc")
	cfg, err := Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != ":8080" {
		t.Errorf("ListenAddr = %q", cfg.ListenAddr)
	}
	if cfg.MaxBodyBytes != 4<<20 {
		t.Errorf("MaxBodyBytes = %d, want 4MiB", cfg.MaxBodyBytes)
	}
	if !cfg.MetricsEnabled || !cfg.ExecEnabled {
		t.Error("metrics and exec must default to enabled")
	}
	if cfg.MaxExecSessions != 10 {
		t.Errorf("MaxExecSessions = %d, want 10", cfg.MaxExecSessions)
	}
	// The topology-independent guard is on by default; it means the same thing
	// wherever kube-console runs.
	if cfg.MaxInFlight != 128 {
		t.Errorf("MaxInFlight = %d, want 128", cfg.MaxInFlight)
	}
	// The IP-keyed guards are off by default. Every deployment kube-console is
	// built for puts a perimeter in front of it (ingress, VPN, authenticating
	// proxy), which is exactly what collapses every user onto one address: a
	// shared budget would 429 the team without denying an attacker anything.
	if cfg.RateLimit != 0 {
		t.Errorf("RateLimit = %d, want 0 (off unless clients are distinguishable)", cfg.RateLimit)
	}
	if cfg.MaxExecHandshakesPerIP != 0 {
		t.Errorf("MaxExecHandshakesPerIP = %d, want 0 (off)", cfg.MaxExecHandshakesPerIP)
	}
	// X-Forwarded-For is client-supplied, so no proxy is trusted until named.
	if len(cfg.TrustedProxies) != 0 {
		t.Errorf("TrustedProxies = %v, want none by default", cfg.TrustedProxies)
	}
}

func TestLoadLimitOverrides(t *testing.T) {
	t.Setenv("KUBE_API_SERVER", "https://kubernetes.default.svc")
	t.Setenv("KUBE_CONSOLE_RATE_LIMIT", "240")
	t.Setenv("KUBE_CONSOLE_MAX_IN_FLIGHT", "16")
	t.Setenv("KUBE_CONSOLE_MAX_EXEC_HANDSHAKES_PER_IP", "3")
	t.Setenv("KUBE_CONSOLE_TRUSTED_PROXIES", "10.0.0.0/8, 2001:db8::/32")
	cfg, err := Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RateLimit != 240 || cfg.MaxInFlight != 16 || cfg.MaxExecHandshakesPerIP != 3 {
		t.Errorf("limits = %d/%d/%d", cfg.RateLimit, cfg.MaxInFlight, cfg.MaxExecHandshakesPerIP)
	}
	if len(cfg.TrustedProxies) != 2 || cfg.TrustedProxies[1] != "2001:db8::/32" {
		t.Errorf("TrustedProxies = %v", cfg.TrustedProxies)
	}
}

// A typo in the proxy CIDRs must fail at startup: chi's XFF middleware panics
// on an invalid prefix, and silently trusting nothing would be worse.
func TestLoadRejectsInvalidTrustedProxy(t *testing.T) {
	t.Setenv("KUBE_API_SERVER", "https://kubernetes.default.svc")
	t.Setenv("KUBE_CONSOLE_TRUSTED_PROXIES", "10.0.0.0/8,not-a-cidr")
	if _, err := Load(nil); err == nil {
		t.Fatal("expected an error for an invalid trusted proxy CIDR")
	}
}

func TestLoadRejectsNegativeLimits(t *testing.T) {
	for _, env := range []string{"KUBE_CONSOLE_RATE_LIMIT", "KUBE_CONSOLE_MAX_IN_FLIGHT", "KUBE_CONSOLE_MAX_EXEC_HANDSHAKES_PER_IP"} {
		t.Run(env, func(t *testing.T) {
			t.Setenv("KUBE_API_SERVER", "https://kubernetes.default.svc")
			t.Setenv(env, "-1")
			if _, err := Load(nil); err == nil {
				t.Fatalf("expected an error for %s=-1", env)
			}
		})
	}
}

func TestLoadEnvOverridesDefaults(t *testing.T) {
	t.Setenv("KUBE_API_SERVER", "https://api.example:6443")
	t.Setenv("KUBE_CA_FILE", "/etc/ca/ca.crt")
	t.Setenv("KUBE_CONSOLE_LISTEN_ADDR", ":9999")
	t.Setenv("KUBE_CONSOLE_EXEC_DISABLE", "true")
	t.Setenv("KUBE_CONSOLE_ALLOWED_ORIGINS", "http://localhost:5173, https://other.example")
	cfg, err := Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KubeAPIServer != "https://api.example:6443" {
		t.Errorf("KubeAPIServer = %q", cfg.KubeAPIServer)
	}
	if cfg.KubeCAFile != "/etc/ca/ca.crt" {
		t.Errorf("KubeCAFile = %q", cfg.KubeCAFile)
	}
	if cfg.ListenAddr != ":9999" {
		t.Errorf("ListenAddr = %q", cfg.ListenAddr)
	}
	if cfg.ExecEnabled {
		t.Error("ExecEnabled should be false from KUBE_CONSOLE_EXEC_DISABLE=true")
	}
	if len(cfg.AllowedOrigins) != 2 || cfg.AllowedOrigins[0] != "http://localhost:5173" {
		t.Errorf("AllowedOrigins = %v", cfg.AllowedOrigins)
	}
}

func TestLoadFlagsOverrideEnv(t *testing.T) {
	t.Setenv("KUBE_API_SERVER", "https://from-env:6443")
	t.Setenv("KUBE_CONSOLE_LISTEN_ADDR", ":9999")
	cfg, err := Load([]string{"--api-server=https://from-flag:6443", "--listen=:7777"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KubeAPIServer != "https://from-flag:6443" {
		t.Errorf("KubeAPIServer = %q, flags must override env", cfg.KubeAPIServer)
	}
	if cfg.ListenAddr != ":7777" {
		t.Errorf("ListenAddr = %q, flags must override env", cfg.ListenAddr)
	}
}

func TestLoadDisableFlagsOverrideEnv(t *testing.T) {
	t.Setenv("KUBE_API_SERVER", "https://kubernetes.default.svc")
	t.Setenv("KUBE_CONSOLE_EXEC_DISABLE", "true")
	cfg, err := Load([]string{"--exec-disable=false", "--metrics-disable"})
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.ExecEnabled {
		t.Error("ExecEnabled should be true: --exec-disable=false must override env-disabled default")
	}
	if cfg.MetricsEnabled {
		t.Error("MetricsEnabled should be false from --metrics-disable")
	}
}

func TestLoadRejectsInvalidEnv(t *testing.T) {
	cases := map[string]string{
		"KUBE_CONSOLE_METRICS_DISABLE":   "yesnt",
		"KUBE_CONSOLE_EXEC_DISABLE":      "flase",
		"KUBE_CONSOLE_MAX_EXEC_SESSIONS": "10x",
		"KUBE_CONSOLE_MAX_BODY_BYTES":    "big",
	}
	for key, val := range cases {
		t.Run(key, func(t *testing.T) {
			t.Setenv("KUBE_API_SERVER", "https://kubernetes.default.svc")
			t.Setenv(key, val)
			if _, err := Load(nil); err == nil {
				t.Fatalf("Load must fail for malformed %s=%q, not silently default", key, val)
			}
		})
	}
}

func TestLoadKubeContext(t *testing.T) {
	t.Setenv("KUBE_API_SERVER", "")
	t.Setenv("KUBE_CONSOLE_KUBECONFIG", "/tmp/kc")
	t.Setenv("KUBE_CONSOLE_KUBECONTEXT", "from-env")

	cfg, err := Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KubeContext != "from-env" {
		t.Errorf("KubeContext = %q, want from-env", cfg.KubeContext)
	}

	cfg, err = Load([]string{"--context=from-flag"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KubeContext != "from-flag" {
		t.Errorf("KubeContext = %q, flag must override env", cfg.KubeContext)
	}
}

func TestLoadAllowsImplicitKubeconfig(t *testing.T) {
	// With neither --api-server nor --kubeconfig the backend defers to standard
	// $KUBECONFIG / ~/.kube/config discovery at connect time, so config loading
	// itself must succeed rather than erroring early.
	t.Setenv("KUBE_API_SERVER", "")
	t.Setenv("KUBE_CONSOLE_KUBECONFIG", "")
	t.Setenv(envServiceHost, "")
	if _, err := Load(nil); err != nil {
		t.Fatalf("Load must not require api-server/kubeconfig: %v", err)
	}
	if _, err := Load([]string{"--kubeconfig=/tmp/kc"}); err != nil {
		t.Fatalf("Load with kubeconfig should succeed: %v", err)
	}
}

func TestLoadInClusterDefaults(t *testing.T) {
	t.Setenv("KUBE_API_SERVER", "")
	t.Setenv("KUBE_CA_FILE", "")
	t.Setenv(envServiceHost, "10.96.0.1")
	t.Setenv(envServicePort, "443")
	withCAFile(t, true)

	cfg, err := Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KubeAPIServer != "https://10.96.0.1:443" {
		t.Errorf("KubeAPIServer = %q, want derived in-cluster URL", cfg.KubeAPIServer)
	}
	if cfg.KubeCAFile != inClusterCAPath {
		t.Errorf("KubeCAFile = %q, want in-cluster CA path", cfg.KubeCAFile)
	}
}

func TestLoadInClusterIPv6(t *testing.T) {
	t.Setenv("KUBE_API_SERVER", "")
	t.Setenv(envServiceHost, "fd00::1")
	t.Setenv(envServicePort, "6443")
	withCAFile(t, false)

	cfg, err := Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KubeAPIServer != "https://[fd00::1]:6443" {
		t.Errorf("KubeAPIServer = %q, want bracketed IPv6 URL", cfg.KubeAPIServer)
	}
}

func TestLoadInClusterSkipsCAWhenMissing(t *testing.T) {
	t.Setenv("KUBE_API_SERVER", "")
	t.Setenv("KUBE_CA_FILE", "")
	t.Setenv(envServiceHost, "10.96.0.1")
	t.Setenv(envServicePort, "443")
	withCAFile(t, false)

	cfg, err := Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KubeCAFile != "" {
		t.Errorf("KubeCAFile = %q, want empty when the CA file is absent", cfg.KubeCAFile)
	}
}

func TestLoadExplicitConfigOverridesInCluster(t *testing.T) {
	t.Setenv(envServiceHost, "10.96.0.1")
	t.Setenv(envServicePort, "443")
	withCAFile(t, true)

	// Explicit --api-server wins and no CA is auto-filled.
	t.Setenv("KUBE_API_SERVER", "")
	t.Setenv("KUBE_CA_FILE", "")
	cfg, err := Load([]string{"--api-server=https://explicit:6443"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KubeAPIServer != "https://explicit:6443" {
		t.Errorf("KubeAPIServer = %q, explicit flag must win over in-cluster", cfg.KubeAPIServer)
	}
	if cfg.KubeCAFile != "" {
		t.Errorf("KubeCAFile = %q, in-cluster CA must not override explicit config", cfg.KubeCAFile)
	}

	// Explicit --kubeconfig also suppresses in-cluster derivation.
	cfg, err = Load([]string{"--kubeconfig=/tmp/kc"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KubeAPIServer != "" {
		t.Errorf("KubeAPIServer = %q, --kubeconfig must suppress in-cluster derivation", cfg.KubeAPIServer)
	}
}

// withCAFile overrides the in-cluster CA existence probe for the test's
// duration.
func withCAFile(t *testing.T, exists bool) {
	t.Helper()
	prev := caFileExists
	caFileExists = func(string) bool { return exists }
	t.Cleanup(func() { caFileExists = prev })
}

func TestLoadClusterName(t *testing.T) {
	t.Setenv("KUBE_API_SERVER", "https://kubernetes.default.svc")
	t.Setenv("KUBE_CONSOLE_CLUSTER_NAME", "  prod-eu  ")
	cfg, err := Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	// Trimmed: the value is a display label, and stray padding would show up
	// verbatim in the browser tab.
	if cfg.ClusterName != "prod-eu" {
		t.Errorf("ClusterName = %q, want prod-eu", cfg.ClusterName)
	}
	cfg, err = Load([]string{"--cluster-name=staging"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClusterName != "staging" {
		t.Errorf("ClusterName = %q, flag must override env", cfg.ClusterName)
	}
}

func TestLoadClusterNameDefaultsEmpty(t *testing.T) {
	t.Setenv("KUBE_API_SERVER", "https://kubernetes.default.svc")
	cfg, err := Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClusterName != "" {
		t.Errorf("ClusterName = %q, want empty by default", cfg.ClusterName)
	}
}

func TestLoadRejectsBadClusterName(t *testing.T) {
	t.Setenv("KUBE_API_SERVER", "https://kubernetes.default.svc")
	cases := map[string]string{
		"control character": "prod\nEU",
		"too long":          strings.Repeat("x", 65),
	}
	for name, value := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Load([]string{"--cluster-name=" + value}); err == nil {
				t.Fatalf("expected error for %q", value)
			}
		})
	}
	// Exactly at the bound, and multi-byte runes counted as runes not bytes.
	if _, err := Load([]string{"--cluster-name=" + strings.Repeat("ы", 64)}); err != nil {
		t.Errorf("64 runes rejected: %v", err)
	}
}
