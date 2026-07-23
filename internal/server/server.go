package server

import (
	"context"
	"errors"
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
