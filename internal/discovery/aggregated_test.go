package discovery

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// serveAggregatedRoots answers both aggregated roots with the package's sample
// payloads (/apis → apps/v1, /api → core/v1).
func serveAggregatedRoots(t *testing.T, w http.ResponseWriter, r *http.Request) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/apis":
		_, _ = w.Write([]byte(aggregatedApis))
	case "/api":
		_, _ = w.Write([]byte(aggregatedApi))
	default:
		t.Errorf("unexpected upstream path %s", r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	}
}

func resourceIDs(rs []Resource) []string {
	out := make([]string, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.ID)
	}
	return out
}

// Regression: the two aggregated roots were fetched back to back, so the
// attempt spent two serial round trips (four, counting the Accept retry) out of
// the half-budget handler.go grants it — the same halving that exists to keep a
// live context for the legacy fallback. Each root's handler here waits for the
// other one to arrive before answering, so sequential code can never satisfy
// both and fails inside peerWait instead of hanging the suite.
func TestFetchAggregatedRootsRunConcurrently(t *testing.T) {
	const peerWait = 2 * time.Second

	apisIn, apiIn := make(chan struct{}), make(chan struct{})
	// OnceFunc so a second request for the same root (a retried Accept variant)
	// cannot close an already-closed channel; the sample bodies are valid, so in
	// practice each root is requested exactly once.
	announceApis := sync.OnceFunc(func() { close(apisIn) })
	announceApi := sync.OnceFunc(func() { close(apiIn) })

	up := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		var (
			announce func()
			peer     chan struct{}
		)
		switch r.URL.Path {
		case "/apis":
			announce, peer = announceApis, apiIn
		case "/api":
			announce, peer = announceApi, apisIn
		default:
			t.Errorf("unexpected upstream path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		announce()
		select {
		case <-peer:
		case <-time.After(peerWait):
			t.Errorf("root %s waited %s alone: the roots are not in flight together", r.URL.Path, peerWait)
		}
		serveAggregatedRoots(t, w, r)
	})

	if _, err := fetchAggregated(context.Background(), up, "tok"); err != nil {
		t.Fatalf("fetchAggregated: %v", err)
	}
}

// Running the roots in parallel must not make the result arrival-ordered: /apis
// resources still come before /api ones, whichever response lands first.
func TestFetchAggregatedKeepsRootOrder(t *testing.T) {
	// Delay /apis so the fast root answers first: with a shared slice appended
	// from both goroutines, this is the case that would reverse the output.
	up := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/apis" {
			time.Sleep(50 * time.Millisecond)
		}
		serveAggregatedRoots(t, w, r)
	})

	out, err := fetchAggregated(context.Background(), up, "tok")
	if err != nil {
		t.Fatalf("fetchAggregated: %v", err)
	}
	want := []string{"apps/v1/deployments", "core/v1/pods", "core/v1/nodes"}
	if got := resourceIDs(out); !slices.Equal(got, want) {
		t.Fatalf("resource order = %v, want %v", got, want)
	}
}

// The error must keep naming the root that failed — it is the whole diagnostic
// value of what the handler logs before falling back — and must keep carrying
// the upstream status, which is how 401/403 reach the client instead of a 502.
func TestFetchAggregatedErrorNamesFailingRoot(t *testing.T) {
	cases := []struct {
		name    string
		badRoot string
		want    string
	}{
		// The colon matters: "/apis" contains "/api", so only the wrapped form
		// tells the two roots apart.
		{name: "apis root", badRoot: "/apis", want: "aggregated discovery /apis:"},
		{name: "api root", badRoot: "/api", want: "aggregated discovery /api:"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			up := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == tc.badRoot {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				serveAggregatedRoots(t, w, r)
			})

			_, err := fetchAggregated(context.Background(), up, "tok")
			if err == nil {
				t.Fatalf("fetchAggregated succeeded although %s failed", tc.badRoot)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %q, want it to contain %q", err, tc.want)
			}
			var se *statusError
			if !errors.As(err, &se) || se.code != http.StatusForbidden {
				t.Fatalf("error = %v, want a wrapped statusError 403", err)
			}
		})
	}
}

// Regression: an aggregated attempt that succeeded but named nothing was served
// as a 200 with an empty catalog. The SPA cannot tell that from an empty
// cluster — useDiscovery coerces with `?? []` and Sidebar renders its error line
// only on isError — so it painted a blank sidebar with no message, which is
// exactly what fetchLegacy's "every group version failed" guard exists to
// prevent. The attempt must fail so legacy discovery answers instead.
func TestFetchAggregatedEmptyCatalogFallsBackToLegacy(t *testing.T) {
	const emptyAggregated = `{"kind":"APIGroupDiscoveryList","items":[]}`

	var legacyHits atomic.Int32
	h := newDiscoveryHandler(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		accept := r.Header.Get("Accept")
		aggregated := strings.Contains(accept, "APIGroupDiscoveryList")
		switch {
		case aggregated && r.URL.Path == "/apis":
			_, _ = w.Write([]byte(emptyAggregated))
		case aggregated && r.URL.Path == "/api":
			_, _ = w.Write([]byte(emptyAggregated))
		case r.URL.Path == "/api":
			legacyHits.Add(1)
			_, _ = w.Write([]byte(`{"kind":"APIVersions","versions":["v1"]}`))
		case r.URL.Path == "/apis":
			legacyHits.Add(1)
			_, _ = w.Write([]byte(`{"kind":"APIGroupList","groups":[]}`))
		case r.URL.Path == "/api/v1":
			_, _ = w.Write([]byte(`{"kind":"APIResourceList","groupVersion":"v1","resources":[
				{"name":"pods","kind":"Pod","namespaced":true,"verbs":["get","list"]}]}`))
		default:
			t.Errorf("unexpected upstream path %s (accept %q)", r.URL.Path, accept)
			w.WriteHeader(http.StatusNotFound)
		}
	})

	rec := getDiscovery(h, "tok")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	byID := decodeResources(t, rec)
	if _, ok := byID["core/v1/pods"]; !ok {
		t.Fatalf("legacy fallback did not run: catalog = %v", byID)
	}
	if legacyHits.Load() == 0 {
		t.Fatal("legacy discovery was never attempted")
	}
}
