package auth

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/n0madic/kube-console/internal/kube"
)

func newVerifyHandler(t *testing.T, upstream http.HandlerFunc) (*Handler, *int) {
	t.Helper()
	calls := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		upstream(w, r)
	}))
	t.Cleanup(ts.Close)
	base, _ := url.Parse(ts.URL)
	up := &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport}
	reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up})
	return NewHandler(reg, slog.New(slog.DiscardHandler)), &calls
}

func postVerify(h *Handler, token string) *httptest.ResponseRecorder {
	return postVerifyContext(h, token, "")
}

func postVerifyContext(h *Handler, token, context string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/ui/auth/verify", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if context != "" {
		req.Header.Set("X-Kube-Context", context)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestVerifySuccess201(t *testing.T) {
	h, _ := newVerifyHandler(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apis/authentication.k8s.io/v1/selfsubjectreviews" {
			t.Errorf("unexpected upstream path %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("unexpected method %s", r.Method)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer user-token" {
			t.Errorf("upstream Authorization = %q", got)
		}
		body, _ := io.ReadAll(r.Body)
		var review map[string]any
		if err := json.Unmarshal(body, &review); err != nil || review["kind"] != "SelfSubjectReview" {
			t.Errorf("unexpected request body: %s", body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{
			"apiVersion":"authentication.k8s.io/v1","kind":"SelfSubjectReview",
			"status":{"userInfo":{"username":"jane","uid":"u-1","groups":["dev","system:authenticated"]}}
		}`))
	})
	rec := postVerify(h, "user-token")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var out VerifyResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.Authenticated || out.Identity == nil || out.Identity.Username != "jane" {
		t.Fatalf("unexpected response: %+v", out)
	}
	if len(out.Identity.Groups) != 2 || out.Identity.UID != "u-1" {
		t.Fatalf("identity mismatch: %+v", out.Identity)
	}
	// No context header → resolved to the default; the frontend stores the
	// first-login session under this name.
	if out.Context != "default" {
		t.Errorf("resolved context = %q, want default", out.Context)
	}
}

func TestVerifyResolvesContextAndReportsName(t *testing.T) {
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("alpha upstream must not be called for a beta request")
	}))
	t.Cleanup(alpha.Close)
	betaHit := false
	beta := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		betaHit = true
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"apiVersion":"authentication.k8s.io/v1","kind":"SelfSubjectReview",
			"status":{"userInfo":{"username":"jane"}}}`))
	}))
	t.Cleanup(beta.Close)
	alphaBase, _ := url.Parse(alpha.URL)
	betaBase, _ := url.Parse(beta.URL)
	reg := kube.NewRegistryFromUpstreams("alpha", map[string]*kube.Upstream{
		"alpha": {BaseURL: alphaBase, Transport: http.DefaultTransport},
		"beta":  {BaseURL: betaBase, Transport: http.DefaultTransport},
	})
	h := NewHandler(reg, slog.New(slog.DiscardHandler))

	rec := postVerifyContext(h, "user-token", "beta")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !betaHit {
		t.Fatal("beta upstream was not contacted")
	}
	var out VerifyResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Context != "beta" {
		t.Errorf("resolved context = %q, want beta", out.Context)
	}
}

func TestVerifyUnknownContext400(t *testing.T) {
	h, calls := newVerifyHandler(t, func(w http.ResponseWriter, r *http.Request) {})
	rec := postVerifyContext(h, "tok", "ghost")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for unknown context", rec.Code)
	}
	if *calls != 0 {
		t.Fatal("upstream must not be called for an unknown context")
	}
}

func TestVerifyInvalidToken401(t *testing.T) {
	h, _ := newVerifyHandler(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
	rec := postVerify(h, "bad-token")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestVerifyForbiddenIsIdentityUnavailable(t *testing.T) {
	h, _ := newVerifyHandler(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})
	rec := postVerify(h, "restricted-token")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (403 must not block the UI)", rec.Code)
	}
	var out VerifyResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.Authenticated || !out.IdentityUnavailable || out.Identity != nil {
		t.Fatalf("unexpected response: %+v", out)
	}
}

func TestVerifyConnectionRefused502(t *testing.T) {
	base, _ := url.Parse("http://127.0.0.1:1")
	up := &kube.Upstream{BaseURL: base, Transport: http.DefaultTransport}
	reg := kube.NewRegistryFromUpstreams("default", map[string]*kube.Upstream{"default": up})
	h := NewHandler(reg, slog.New(slog.DiscardHandler))
	rec := postVerify(h, "any-token")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
}

func TestVerifyMissingBearer(t *testing.T) {
	h, calls := newVerifyHandler(t, func(w http.ResponseWriter, r *http.Request) {})
	rec := postVerify(h, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if *calls != 0 {
		t.Fatal("upstream must not be called without a token")
	}
}

// Regression: the SelfSubjectReview call ran on the bare request context, so
// an upstream that accepted the connection and never responded pinned the
// handler goroutine for as long as the client kept its socket open.
func TestVerifyUpstreamStallBoundedByTimeout(t *testing.T) {
	prev := upstreamTimeout
	upstreamTimeout = 100 * time.Millisecond
	t.Cleanup(func() { upstreamTimeout = prev })

	// Unblocked in cleanup (LIFO: runs before the server's Close) so the
	// stalled upstream handler never wedges httptest.Server.Close.
	stop := make(chan struct{})
	h, _ := newVerifyHandler(t, func(w http.ResponseWriter, r *http.Request) {
		select { // stall until the client abandons the request
		case <-r.Context().Done():
		case <-stop:
		}
	})
	t.Cleanup(func() { close(stop) })
	start := time.Now()
	rec := postVerify(h, "tok")
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("handler blocked for %v; timeout not applied", elapsed)
	}
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502; body %s", rec.Code, rec.Body.String())
	}
}
