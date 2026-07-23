package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// deadlineRecorder is a ResponseWriter that records SetReadDeadline calls so
// tests can assert whether maxBody applied a per-request body read deadline.
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

func TestMaxBodySetsReadDeadlineForBodyMethods(t *testing.T) {
	handler := maxBody(1<<20, 30*time.Second, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

func TestMaxBodyNoReadDeadlineForWatch(t *testing.T) {
	handler := maxBody(1<<20, 30*time.Second, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// GET (list/watch/log) must never get a read deadline: the response streams
	// long and setting one would risk cutting it short.
	rec := &deadlineRecorder{ResponseWriter: httptest.NewRecorder()}
	req := httptest.NewRequest(http.MethodGet, "/k8s/api/v1/pods?watch=true", nil)
	handler.ServeHTTP(rec, req)
	if rec.setCalled {
		t.Fatal("GET/watch must not receive a read deadline")
	}
}

func TestMaxBodyDisabledTimeout(t *testing.T) {
	// A zero timeout disables the deadline entirely.
	handler := maxBody(1<<20, 0, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := &deadlineRecorder{ResponseWriter: httptest.NewRecorder()}
	req := httptest.NewRequest(http.MethodPost, "/k8s/api/v1/pods", strings.NewReader("{}"))
	handler.ServeHTTP(rec, req)
	if rec.setCalled {
		t.Fatal("a zero BodyReadTimeout must not set any read deadline")
	}
}
