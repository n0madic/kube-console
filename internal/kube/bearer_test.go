package kube

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

type captureRT struct {
	req *http.Request
}

func (c *captureRT) RoundTrip(req *http.Request) (*http.Response, error) {
	c.req = req
	rec := httptest.NewRecorder()
	rec.WriteHeader(http.StatusOK)
	return rec.Result(), nil
}

func TestWithBearerClonesRequest(t *testing.T) {
	capture := &captureRT{}
	rt := WithBearer(capture, "user-token")

	original := httptest.NewRequest(http.MethodGet, "http://upstream/api", nil)
	original.Header.Set("Accept", "application/json")

	resp, err := rt.RoundTrip(original)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	if got := capture.req.Header.Get("Authorization"); got != "Bearer user-token" {
		t.Errorf("outgoing Authorization = %q", got)
	}
	if got := original.Header.Get("Authorization"); got != "" {
		t.Errorf("original request was mutated: Authorization = %q", got)
	}
	if capture.req == original {
		t.Error("request must be cloned, not reused")
	}
	if got := capture.req.Header.Get("Accept"); got != "application/json" {
		t.Errorf("cloned request lost Accept header: %q", got)
	}
}

func TestExtractBearer(t *testing.T) {
	cases := []struct {
		auth string
		want string
	}{
		{"Bearer abc123", "abc123"},
		{"bearer abc123", "abc123"},
		{"BEARER abc123", "abc123"},
		{"Basic dXNlcjpwYXNz", ""},
		{"", ""},
		{"Bearer", ""},
		{"Bearer ", ""},
		{"Bearer a b", ""},
		{"Bearertoken", ""},
	}
	for _, tc := range cases {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		if tc.auth != "" {
			r.Header.Set("Authorization", tc.auth)
		}
		if got := ExtractBearer(r); got != tc.want {
			t.Errorf("ExtractBearer(%q) = %q, want %q", tc.auth, got, tc.want)
		}
	}
}
