package config

import (
	"os"
	"strconv"
	"strings"
	"testing"
)

// Load reads the process environment, so whatever is exported in the shell that
// runs `go test` is part of every case below. A developer who has just run the
// local kubeconfig mode carries KUBE_CONSOLE_USE_KUBECONFIG_CREDENTIALS, and
// then every test here fails on validate ("requires a kubeconfig", "requires a
// loopback listen address") for a reason that has nothing to do with the test.
//
// Cleared by prefix rather than from a list of names: a new KUBE_CONSOLE_*
// setting must not silently reintroduce this, and the two spec-fixed names have
// no prefix to catch them by.
func TestMain(m *testing.M) {
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "KUBE_CONSOLE_") || key == envAPIServer || key == envCAFile {
			if err := os.Unsetenv(key); err != nil {
				panic(err)
			}
		}
	}
	os.Exit(m.Run())
}

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

// The concurrency knobs each size a channel-backed pool at a fixed multiple of
// their value (8x MaxInFlight for the stream pool, 2x MaxExecSessions for the
// exec pending pool), so a huge value must fail at startup like any other bad
// config: past overflow the product makes make(chan) panic on a negative
// capacity, and a product wrapping to exactly zero builds an unbuffered pool
// that silently sheds every stream with a 429.
func TestLoadRejectsHugeConcurrencyLimits(t *testing.T) {
	for _, env := range []string{"KUBE_CONSOLE_MAX_IN_FLIGHT", "KUBE_CONSOLE_MAX_EXEC_SESSIONS"} {
		// Just past the ceiling, then the overflow shapes: 8*2^60 goes negative,
		// 8*2^61 and 2*2^62 wrap to zero on 64-bit int.
		for _, val := range []string{
			strconv.Itoa(maxConcurrencyLimit + 1),
			"1152921504606846976", // 1<<60
			"2305843009213693952", // 1<<61
			"4611686018427387904", // 1<<62
		} {
			t.Run(env+"="+val, func(t *testing.T) {
				t.Setenv("KUBE_API_SERVER", "https://kubernetes.default.svc")
				t.Setenv(env, val)
				if _, err := Load(nil); err == nil {
					t.Fatalf("expected an error for %s=%s", env, val)
				}
			})
		}
	}
	// The bound itself must not reject generous real values.
	t.Setenv("KUBE_API_SERVER", "https://kubernetes.default.svc")
	t.Setenv("KUBE_CONSOLE_MAX_IN_FLIGHT", strconv.Itoa(maxConcurrencyLimit))
	t.Setenv("KUBE_CONSOLE_MAX_EXEC_SESSIONS", strconv.Itoa(maxConcurrencyLimit))
	if _, err := Load(nil); err != nil {
		t.Fatalf("a value at the ceiling must pass: %v", err)
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

	// Explicit --api-server wins for the URL; the mounted CA still fills in as
	// the trust anchor (see TestLoadInClusterCAWithExplicitAPIServer).
	t.Setenv("KUBE_API_SERVER", "")
	t.Setenv("KUBE_CA_FILE", "")
	cfg, err := Load([]string{"--api-server=https://explicit:6443"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KubeAPIServer != "https://explicit:6443" {
		t.Errorf("KubeAPIServer = %q, explicit flag must win over in-cluster", cfg.KubeAPIServer)
	}

	// An explicit --ca-file is never overridden by the mounted one.
	cfg, err = Load([]string{"--api-server=https://explicit:6443", "--ca-file=/etc/ca/ca.crt"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KubeCAFile != "/etc/ca/ca.crt" {
		t.Errorf("KubeCAFile = %q, explicit --ca-file must win over the mounted CA", cfg.KubeCAFile)
	}

	// Explicit --kubeconfig also suppresses in-cluster URL derivation.
	cfg, err = Load([]string{"--kubeconfig=/tmp/kc"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KubeAPIServer != "" {
		t.Errorf("KubeAPIServer = %q, --kubeconfig must suppress in-cluster derivation", cfg.KubeAPIServer)
	}
}

// A pod that pins the apiserver URL via KUBE_API_SERVER still needs the
// mounted cluster CA: the host source and the trust anchor are independent
// settings, and without the CA every upstream round trip fails on the
// apiserver's self-signed certificate with nothing naming the cause — the
// readiness probe just stays unready.
func TestLoadInClusterCAWithExplicitAPIServer(t *testing.T) {
	t.Setenv("KUBE_API_SERVER", "https://explicit:6443")
	t.Setenv("KUBE_CA_FILE", "")
	t.Setenv(envServiceHost, "10.96.0.1")
	t.Setenv(envServicePort, "443")
	withCAFile(t, true)

	cfg, err := Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.KubeAPIServer != "https://explicit:6443" {
		t.Errorf("KubeAPIServer = %q, explicit env must win over in-cluster", cfg.KubeAPIServer)
	}
	if cfg.KubeCAFile != inClusterCAPath {
		t.Errorf("KubeCAFile = %q, want the mounted in-cluster CA", cfg.KubeCAFile)
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

// --use-kubeconfig-credentials is the carve-out from the zero-credential
// invariant, so what it accepts and what it refuses is the whole guard.
func TestLoadUseKubeconfigCredentials(t *testing.T) {
	clearConnectionEnv := func(t *testing.T) {
		t.Helper()
		t.Setenv("KUBE_API_SERVER", "")
		t.Setenv("KUBE_CONSOLE_KUBECONFIG", "")
		t.Setenv(envServiceHost, "")
		t.Setenv(envServicePort, "")
	}

	t.Run("off by default", func(t *testing.T) {
		t.Setenv("KUBE_API_SERVER", "https://kubernetes.default.svc")
		cfg, err := Load(nil)
		if err != nil {
			t.Fatal(err)
		}
		if cfg.UseKubeconfigCredentials {
			t.Error("UseKubeconfigCredentials must default to false")
		}
	})

	t.Run("flag", func(t *testing.T) {
		clearConnectionEnv(t)
		cfg, err := Load([]string{"--kubeconfig=/tmp/kc", "--listen=127.0.0.1:8080", "--use-kubeconfig-credentials"})
		if err != nil {
			t.Fatal(err)
		}
		if !cfg.UseKubeconfigCredentials {
			t.Error("--use-kubeconfig-credentials did not set the field")
		}
	})

	t.Run("env", func(t *testing.T) {
		clearConnectionEnv(t)
		t.Setenv(envUseKubeconfigCreds, "true")
		t.Setenv(envListenAddr, "localhost:8080")
		t.Setenv("KUBE_CONSOLE_KUBECONFIG", "/tmp/kc")
		cfg, err := Load(nil)
		if err != nil {
			t.Fatal(err)
		}
		if !cfg.UseKubeconfigCredentials {
			t.Errorf("%s=true did not set the field", envUseKubeconfigCreds)
		}
	})

	t.Run("loopback listen addresses", func(t *testing.T) {
		for _, addr := range []string{"127.0.0.1:8080", "[::1]:8080", "localhost:8080", "127.0.0.2:9000"} {
			clearConnectionEnv(t)
			if _, err := Load([]string{"--kubeconfig=/tmp/kc", "--listen=" + addr, "--use-kubeconfig-credentials"}); err != nil {
				t.Errorf("--listen=%s rejected: %v", addr, err)
			}
		}
	})

	t.Run("non-loopback listen rejected", func(t *testing.T) {
		// Reaching the listener is enough to act as the kubeconfig's owner, so a
		// published one is a startup error, not a warning.
		for _, addr := range []string{":8080", "0.0.0.0:8080", "10.0.0.5:8080", "[::]:8080", "8080"} {
			clearConnectionEnv(t)
			_, err := Load([]string{"--kubeconfig=/tmp/kc", "--listen=" + addr, "--use-kubeconfig-credentials"})
			if err == nil {
				t.Errorf("--listen=%s accepted, want a loopback-only error", addr)
				continue
			}
			if !strings.Contains(err.Error(), "loopback") {
				t.Errorf("--listen=%s error = %q, want it to name loopback", addr, err)
			}
		}
	})

	t.Run("api-server rejected", func(t *testing.T) {
		clearConnectionEnv(t)
		_, err := Load([]string{"--api-server=https://explicit:6443", "--listen=127.0.0.1:8080", "--use-kubeconfig-credentials"})
		if err == nil {
			t.Fatal("--api-server carries no credentials; the combination must fail")
		}
		if !strings.Contains(err.Error(), "kubeconfig") {
			t.Errorf("error = %q, want it to name the kubeconfig requirement", err)
		}
	})

	t.Run("in-cluster rejected", func(t *testing.T) {
		// The ServiceAccount token is never read, so in-cluster there would be
		// nothing to authenticate with. Both shapes must fail: without a
		// kubeconfig (applyInClusterDefaults fills KubeAPIServer) and — the one
		// a derived-KubeAPIServer check misses — with one mounted, where
		// applyInClusterDefaults returns early and leaves it empty. A pod's
		// loopback is shared with every container in it, so the listen fence
		// alone would hand the kubeconfig to any sidecar.
		for name, args := range map[string][]string{
			"no kubeconfig":    {"--listen=127.0.0.1:8080", "--use-kubeconfig-credentials"},
			"kubeconfig mount": {"--kubeconfig=/etc/kc/config", "--listen=127.0.0.1:8080", "--use-kubeconfig-credentials"},
		} {
			t.Run(name, func(t *testing.T) {
				clearConnectionEnv(t)
				t.Setenv(envServiceHost, "10.96.0.1")
				t.Setenv(envServicePort, "443")
				withCAFile(t, true)
				if _, err := Load(args); err == nil {
					t.Fatal("in-cluster mode must reject --use-kubeconfig-credentials")
				}
			})
		}
	})
}
