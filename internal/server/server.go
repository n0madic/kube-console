package server

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"time"

	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/kube"
)

// Run builds the upstream connection and serves HTTP until ctx is cancelled,
// then shuts down gracefully.
func Run(ctx context.Context, cfg *config.Config, logger *slog.Logger, version string, dist fs.FS) error {
	registry, err := kube.NewRegistry(cfg)
	if err != nil {
		return err
	}
	// One credential mode, one source of truth. Everything downstream reads the
	// registry — what RESTConfigs actually did — and config.validate has already
	// rejected every combination in which the flag could fail to reach it
	// (--api-server, in-cluster). So a disagreement here means the request was
	// silently not honoured, and the two states it leaves are exactly the ones
	// not to serve: a login page in front of upstreams that need no token, or
	// credentialed upstreams behind whichever fences the flag alone would mount.
	if registry.UsesConfigCredentials() != cfg.UseKubeconfigCredentials {
		built := "credential-free"
		if registry.UsesConfigCredentials() {
			built = "with its own credentials"
		}
		return fmt.Errorf("--use-kubeconfig-credentials=%v but the default context %q was built %s: "+
			"the carve-out applies to kubeconfig contexts only",
			cfg.UseKubeconfigCredentials, registry.DefaultName(), built)
	}

	handler := NewHandler(Deps{
		Cfg:         cfg,
		Registry:    registry,
		Logger:      logger,
		Version:     version,
		DistFS:      dist,
		ShutdownCtx: ctx,
	})

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: cfg.ReadHeaderTimeout,
		IdleTimeout:       cfg.IdleTimeout,
		MaxHeaderBytes:    1 << 20,
		// No WriteTimeout: it would terminate long-running watch/log streams.
		ErrorLog: slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.ListenAndServe()
	}()
	logger.Info("kube-console listening",
		"addr", cfg.ListenAddr,
		"context", registry.DefaultName(),
		"contexts", len(registry.Names()),
		// parseHost already dropped any userinfo; Redacted keeps this line safe
		// even if an upstream URL ever reaches it another way.
		"upstream", registry.Default().BaseURL.Redacted(),
		"version", version,
	)
	if cfg.UseKubeconfigCredentials {
		// The zero-credential invariant is off. Say so loudly and in full: from
		// here on there is no login page and no per-user token — anyone who can
		// reach this port acts as the owner of the kubeconfig, on every context
		// it enumerates. config.validate has already pinned the listener to
		// loopback, which is the only thing keeping "anyone" to this machine.
		logger.Warn("kubeconfig credentials are in use — no login required",
			"addr", cfg.ListenAddr,
			"contexts", len(registry.Names()),
			"warning", "every request to this loopback address acts as the kubeconfig owner")
	}
	// The IP-keyed limits are opt-in, so state what is actually in force
	// instead of leaving an operator to infer it from the absence of 429s.
	logger.Info("abuse limits",
		"maxInFlight", cfg.MaxInFlight,
		"rateLimitPerMinute", cfg.RateLimit,
		"maxExecHandshakesPerIP", cfg.MaxExecHandshakesPerIP,
		"maxExecSessions", cfg.MaxExecSessions,
		"trustedProxies", len(cfg.TrustedProxies),
		// Not IP-keyed and not a 429, but it is the limit that drops a client
		// outright, and the one that makes maxInFlight mean anything.
		"responseWriteTimeout", cfg.ResponseWriteTimeout.String(),
	)

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
			_ = srv.Close()
			return err
		}
		_ = srv.Close()
		return nil
	}
}
