package server

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/kube"
)

// TestShutdownAbortsActiveWatchInsteadOfWaitingOutTheGracePeriod is an
// end-to-end regression test: a page watching resources used to keep the
// backend hanging on shutdown until srv.Shutdown()'s fixed grace period
// force-closed every connection (watch and otherwise). ShutdownCtx +
// AbortOnShutdown must cut the active watch immediately so a normal
// srv.Shutdown() call completes fast instead of riding out the timeout.
func TestShutdownAbortsActiveWatchInsteadOfWaitingOutTheGracePeriod(t *testing.T) {
	// Fake apiserver: a watch handler that streams until its request context
	// is cancelled, exactly like a real `kubectl get pods -w` upstream.
	upstreamReady := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		close(upstreamReady)
		<-r.Context().Done()
	}))
	defer upstream.Close()

	base, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{
		"default": {BaseURL: base, Transport: http.DefaultTransport},
	})

	shutdownCtx, cancelShutdown := context.WithCancel(context.Background())
	handler := NewHandler(Deps{
		Cfg:         &config.Config{MaxBodyBytes: 1 << 20},
		Registry:    reg,
		Logger:      slog.New(slog.DiscardHandler),
		DistFS:      fstest.MapFS{},
		ShutdownCtx: shutdownCtx,
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: handler}
	go srv.Serve(ln)
	defer srv.Close()

	// Start a watch request and wait until it's actually streaming, just like
	// a browser tab left open on a resource list page.
	req, _ := http.NewRequest(http.MethodGet, "http://"+ln.Addr().String()+"/k8s/api/v1/pods?watch=true", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	<-upstreamReady

	// Fire shutdown exactly like Run does, with a generous timeout: if the
	// watch weren't aborted, Shutdown would block for this whole window.
	cancelShutdown()
	shutdownDeadline, cancelDeadline := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelDeadline()

	done := make(chan error, 1)
	go func() { done <- srv.Shutdown(shutdownDeadline) }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Shutdown() = %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown() hung waiting for the active watch instead of aborting it on shutdown")
	}

	_, _ = io.Copy(io.Discard, resp.Body)
}

// The credential mode has exactly one source of truth downstream — the registry
// — so Run refuses to serve a registry that disagrees with the flag instead of
// leaving the two to be read separately (the loopback fence used to be mounted
// off either). --api-server is the combination that produces one: RESTConfigs
// anonymizes that branch whatever the flag says, and config.validate rejects it
// before Run in every real startup.
func TestRunRejectsACredentialModeTheRegistryDidNotHonour(t *testing.T) {
	cfg := &config.Config{
		ListenAddr:               "127.0.0.1:0",
		KubeAPIServer:            "https://apiserver.example:6443",
		UseKubeconfigCredentials: true,
		MaxBodyBytes:             1 << 20,
	}
	err := Run(context.Background(), cfg, slog.New(slog.DiscardHandler), "test", fstest.MapFS{})
	if err == nil {
		t.Fatal("Run served an anonymized registry as if it carried kubeconfig credentials")
	}
	if !strings.Contains(err.Error(), "use-kubeconfig-credentials") {
		t.Errorf("error does not name the flag it is about: %v", err)
	}
}
