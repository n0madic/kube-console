// Command kube-console serves the stateless Kubernetes web console: embedded
// SPA, constrained /k8s gateway and /api/ui adapters.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/server"
	"github.com/n0madic/kube-console/web"
)

// version is injected at build time via -ldflags "-X main.version=...": the git
// tag when HEAD carries one, else the short commit (see the Makefile and the CI
// image job, which must agree). It is reported by --version, by the startup log
// line, by /healthz, and on screen in the sidebar footer via GET
// /api/ui/contexts.
var version = "dev"

func main() {
	cfg, err := config.Load(os.Args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(0)
		}
		if errors.Is(err, config.ErrVersionRequested) {
			fmt.Println(version)
			os.Exit(0)
		}
		fmt.Fprintln(os.Stderr, "kube-console:", err)
		os.Exit(2)
	}

	logger := newLogger(cfg)
	// Registry construction warns (skipped/unusual kubeconfig contexts) via
	// slog.Default(); route those through the configured handler too.
	slog.SetDefault(logger)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := server.Run(ctx, cfg, logger, version, web.Dist()); err != nil {
		logger.Error("server exited with error", "error", err)
		os.Exit(1)
	}
}

func newLogger(cfg *config.Config) *slog.Logger {
	var level slog.Level
	switch strings.ToLower(cfg.LogLevel) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: level}
	var handler slog.Handler
	if strings.EqualFold(cfg.LogFormat, "json") {
		handler = slog.NewJSONHandler(os.Stderr, opts)
	} else {
		handler = slog.NewTextHandler(os.Stderr, opts)
	}
	return slog.New(handler)
}
