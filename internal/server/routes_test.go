package server

import (
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/n0madic/kube-console/internal/config"
	"github.com/n0madic/kube-console/internal/kube"
)

// deadlineRecorder is a ResponseWriter that records SetReadDeadline calls so
// tests can assert whether bodyReadDeadline applied a per-request body read
// deadline.
type deadlineRecorder struct {
	http.ResponseWriter
	setCalled bool
	deadline  time.Time
}

func (d *deadlineRecorder) SetReadDeadline(t time.Time) error {
	d.setCalled = true
	d.deadline = t
	return nil
}

func TestBodyReadDeadlineSetsDeadlineForBodyMethods(t *testing.T) {
	handler := bodyReadDeadline(30 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	bodyMethods := []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete}
	for _, m := range bodyMethods {
		rec := &deadlineRecorder{ResponseWriter: httptest.NewRecorder()}
		req := httptest.NewRequest(m, "/k8s/api/v1/namespaces/ns/pods", strings.NewReader("{}"))
		handler.ServeHTTP(rec, req)
		if !rec.setCalled {
			t.Errorf("%s: expected a body read deadline to be set", m)
		}
		if rec.deadline.IsZero() {
			t.Errorf("%s: read deadline must be a concrete future time", m)
		}
	}
}

func TestBodyReadDeadlineNoDeadlineForWatch(t *testing.T) {
	handler := bodyReadDeadline(30 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// GET (list/watch/log) must never get a read deadline: the response streams
	// long, and an expired read deadline fails net/http's background read,
	// which cancels the request context and cuts the stream short.
	rec := &deadlineRecorder{ResponseWriter: httptest.NewRecorder()}
	req := httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods?watch=true", nil)
	handler.ServeHTTP(rec, req)
	if rec.setCalled {
		t.Fatal("GET/watch must not receive a read deadline")
	}
}

func TestBodyReadDeadlineZeroIsPassthrough(t *testing.T) {
	// A zero timeout disables the middleware entirely, as with WriteDeadline.
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	got := bodyReadDeadline(0)(inner)
	if reflect.ValueOf(got).Pointer() != reflect.ValueOf(inner).Pointer() {
		t.Fatal("a zero timeout must return the handler unwrapped")
	}

	rec := &deadlineRecorder{ResponseWriter: httptest.NewRecorder()}
	bodyReadDeadline(0)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/k8s/api/v1/pods", strings.NewReader("{}")))
	if rec.setCalled {
		t.Fatal("a zero BodyReadTimeout must not set any read deadline")
	}
}

func TestMaxBodyCapsRequestBodySize(t *testing.T) {
	var readErr error
	handler := maxBody(8, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, readErr = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPost, "/k8s/api/v1/pods", strings.NewReader(strings.Repeat("x", 64)))
	handler.ServeHTTP(httptest.NewRecorder(), req)

	var mbe *http.MaxBytesError
	if !errors.As(readErr, &mbe) {
		t.Fatalf("read error = %v, want *http.MaxBytesError", readErr)
	}
}

// TestBodyReadDeadlineBoundsSlowBodyOnEveryRoute is the regression for the
// finding: the read deadline used to live inside maxBody on the gateway alone,
// so a POST to any other route — an /api/ui adapter, the /api 404, the SPA
// fallback — could drip its body forever. net/http drains up to 256KiB of
// unread body after the handler returns and before the response headers go
// out, and with the header deadline already cleared nothing bounded that read:
// one connection and one goroutine per drip, reachable without a token.
func TestBodyReadDeadlineBoundsSlowBodyOnEveryRoute(t *testing.T) {
	const timeout = 300 * time.Millisecond
	h := NewHandler(Deps{
		Cfg: &config.Config{
			MaxBodyBytes:    4 << 20,
			BodyReadTimeout: timeout,
			MaxExecSessions: 1,
		},
		Registry: kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{
			"default": {
				BaseURL:   mustParseURL(t, "https://apiserver.example"),
				Transport: http.DefaultTransport,
			},
		}),
		Logger:  slog.New(slog.DiscardHandler),
		Version: "test",
		DistFS:  testDist,
	})
	srv := httptest.NewServer(h)
	defer srv.Close()

	// The three shapes reachable without a token: a real /api/ui handler that
	// never reads its body, the /api 404, and the SPA fallback.
	for _, path := range []string{"/api/ui/auth/verify", "/api/ui/nope", "/"} {
		t.Run(path, func(t *testing.T) {
			conn, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
			if err != nil {
				t.Fatalf("dial: %v", err)
			}
			defer conn.Close()
			// Headers plus one byte of a body that never finishes.
			if _, err := io.WriteString(conn,
				"POST "+path+" HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\nx"); err != nil {
				t.Fatalf("write request: %v", err)
			}

			// The response cannot go out before the post-handler drain, so its
			// arrival is the drain being cut by the deadline.
			start := time.Now()
			_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
			if _, err := conn.Read(make([]byte, 1)); err != nil {
				t.Fatalf("no response within 10s: the body drain is unbounded again (%v)", err)
			}
			if elapsed := time.Since(start); elapsed > 5*time.Second {
				t.Fatalf("response after %v, want it within the body read deadline", elapsed)
			}
		})
	}
}

// The other half of the split: the deadline is armed per request on the shared
// connection, so a GET watch through the full router must stream past the
// timeout untouched. If it were armed for GETs, net/http's background read
// would time out mid-stream, cancel the request context and truncate the body.
func TestBodyReadDeadlineLeavesWatchStreamsAlone(t *testing.T) {
	const timeout = 200 * time.Millisecond
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{\"type\":\"ADDED\"}\n"))
		w.(http.Flusher).Flush()
		// Quiet for far longer than the body deadline, as an idle watch is,
		// then one more event and a clean end.
		time.Sleep(4 * timeout)
		_, _ = w.Write([]byte("{\"type\":\"MODIFIED\"}\n"))
	}))
	defer upstream.Close()

	h := NewHandler(Deps{
		Cfg: &config.Config{
			MaxBodyBytes:    4 << 20,
			BodyReadTimeout: timeout,
			MaxExecSessions: 1,
		},
		Registry: kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{
			"default": {
				BaseURL:   mustParseURL(t, upstream.URL),
				Transport: http.DefaultTransport,
			},
		}),
		Logger:  slog.New(slog.DiscardHandler),
		Version: "test",
		DistFS:  testDist,
	})
	srv := httptest.NewServer(h)
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/k8s/api/v1/pods?watch=true", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("watch ended with %v instead of a clean EOF (body=%q)", err, body)
	}
	if !strings.Contains(string(body), "MODIFIED") {
		t.Fatalf("watch was cut before the event past the deadline window: %q", body)
	}
}
