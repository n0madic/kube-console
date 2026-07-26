package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/n0madic/kube-console/internal/gateway"
)

// status issues one request through h and reports the status code.
func status(h http.Handler, target string) int {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec.Code
}

// classifiedStack wires the /k8s/* middlewares the way NewHandler does:
// classifier outermost, then the in-flight cap, then AbortOnShutdown, then the
// handler. Wrapping is inside-out, so the last wrap runs first.
func classifiedStack(max int, terminal http.Handler) http.Handler {
	classifier := newStreamClassifier(gateway.IsStreaming)
	h := AbortOnShutdown(context.Background(), classifier.verdict)(terminal)
	h = newInFlightLimiter(max).middleware(classifier.verdict)(h)
	return classifier.middleware(h)
}

// Two middlewares on /k8s/* need the same verdict about the same request, and
// gateway.IsStreaming pays for it every time: it parses the query and walks the
// path segments for the deprecated legacy-watch prefix. The classifier resolves
// it once; every later reader — including the innermost handler, whose context
// is the one AbortOnShutdown derived with context.WithCancelCause — must get the
// cached answer rather than re-run the predicate.
func TestStreamClassifierEvaluatesPredicateOncePerRequest(t *testing.T) {
	tests := []struct {
		name   string
		target string
		want   bool
	}{
		{"streaming", "/k8s/api/v1/pods?watch=true", true},
		{"unary", "/k8s/api/v1/pods", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int64
			classifier := newStreamClassifier(func(r *http.Request) bool {
				calls.Add(1)
				return gateway.IsStreaming(r)
			})

			// One request, one goroutine: no synchronization needed.
			seen := map[string]bool{}
			reader := func(who string) func(*http.Request) bool {
				return func(r *http.Request) bool {
					v := classifier.verdict(r)
					seen[who] = v
					return v
				}
			}

			var h http.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				seen["handler"] = classifier.verdict(r)
				w.WriteHeader(http.StatusOK)
			})
			h = AbortOnShutdown(context.Background(), reader("shutdown"))(h)
			h = newInFlightLimiter(4).middleware(reader("inflight"))(h)
			h = classifier.middleware(h)

			if code := status(h, tc.target); code != http.StatusOK {
				t.Fatalf("status = %d, want 200", code)
			}
			if got := calls.Load(); got != 1 {
				t.Errorf("predicate evaluated %d times, want exactly 1: the verdict must be resolved once and shared", got)
			}
			for _, who := range []string{"inflight", "shutdown", "handler"} {
				got, ok := seen[who]
				if !ok {
					t.Errorf("%s never read the verdict", who)
					continue
				}
				if got != tc.want {
					t.Errorf("%s read verdict %v, want %v", who, got, tc.want)
				}
			}
		})
	}
}

// The shared verdict has to reach the in-flight cap's pool selection, not just
// be readable: a stream misclassified as unary pins a slot in the small pool for
// as long as the page stays open, and a unary request misclassified as a stream
// is outside the only global concurrency bound.
func TestStreamClassifierVerdictSelectsPools(t *testing.T) {
	// A request carrying "hold" parks in the handler with its slot taken;
	// "hold" alone is not a streaming shape, "watch=true&hold" is.
	hold := func(release <-chan struct{}, entered *sync.WaitGroup) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Has("hold") {
				entered.Done()
				<-release
			}
			w.WriteHeader(http.StatusOK)
		})
	}

	t.Run("a watch is not shed by a full unary pool", func(t *testing.T) {
		release := make(chan struct{})
		var entered, done sync.WaitGroup
		entered.Add(1)
		h := classifiedStack(1, hold(release, &entered)) // 1 unary slot

		done.Add(1)
		go func() {
			defer done.Done()
			status(h, "/k8s/api/v1/pods?hold")
		}()
		entered.Wait()

		if code := status(h, "/k8s/api/v1/pods"); code != http.StatusTooManyRequests {
			t.Errorf("second unary request: status = %d, want 429 while the only unary slot is held", code)
		}
		if code := status(h, "/k8s/api/v1/pods?watch=true"); code != http.StatusOK {
			t.Errorf("watch: status = %d, want 200 — a stream must be routed into the stream pool", code)
		}
		close(release)
		done.Wait()
	})

	t.Run("a unary request is not shed by a full stream pool", func(t *testing.T) {
		release := make(chan struct{})
		var entered, done sync.WaitGroup
		entered.Add(streamPoolFactor)
		h := classifiedStack(1, hold(release, &entered)) // streamPoolFactor stream slots

		for i := 0; i < streamPoolFactor; i++ {
			done.Add(1)
			go func() {
				defer done.Done()
				status(h, "/k8s/api/v1/pods?watch=true&hold")
			}()
		}
		entered.Wait()

		if code := status(h, "/k8s/api/v1/pods?watch=true"); code != http.StatusTooManyRequests {
			t.Errorf("watch: status = %d, want 429 — the stream pool is bounded and full", code)
		}
		if code := status(h, "/k8s/api/v1/pods"); code != http.StatusOK {
			t.Errorf("unary request: status = %d, want 200 — its own pool is untouched", code)
		}
		close(release)
		done.Wait()
	})
}

// verdict must fall back to evaluating the predicate when the context carries no
// value. That is the anti-opt-out guarantee: "long-lived" is decided by a
// client-supplied query parameter, so a consumer mounted without the classifier
// in front of it — the shape the /api subrouter already has — must still get the
// right answer instead of the zero value.
func TestStreamClassifierVerdictFallsBackWithoutContextValue(t *testing.T) {
	classifier := newStreamClassifier(gateway.IsStreaming)

	if !classifier.verdict(httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods?watch=true", nil)) {
		t.Error("a watch must be reported as long-lived even with no verdict on the context")
	}
	if classifier.verdict(httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods", nil)) {
		t.Error("a plain request must not be reported as long-lived")
	}

	// End to end: the cap alone, with no classifier mounted ahead of it, still
	// has to send a watch to the stream pool.
	release := make(chan struct{})
	var entered, done sync.WaitGroup
	entered.Add(1)
	h := newInFlightLimiter(1).middleware(classifier.verdict)(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Has("hold") {
				entered.Done()
				<-release
			}
			w.WriteHeader(http.StatusOK)
		}))

	done.Add(1)
	go func() {
		defer done.Done()
		status(h, "/k8s/api/v1/pods?hold")
	}()
	entered.Wait()

	if code := status(h, "/k8s/api/v1/pods?watch=true"); code != http.StatusOK {
		t.Errorf("watch: status = %d, want 200 — without the classifier the predicate must still be consulted", code)
	}
	close(release)
	done.Wait()
}
