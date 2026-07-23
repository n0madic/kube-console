package kube

import (
	"net/http"
	"strings"
)

// bearerRoundTripper injects a user bearer token into a cloned request. It is
// request-scoped: constructed per request/connection and never cached. The
// base transport is the shared credential-free transport and is never mutated.
type bearerRoundTripper struct {
	base  http.RoundTripper
	token string
}

// WithBearer wraps base with a RoundTripper that sets the Authorization
// header on a clone of each outgoing request.
func WithBearer(base http.RoundTripper, token string) http.RoundTripper {
	return &bearerRoundTripper{base: base, token: token}
}

func (b *bearerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.Header.Set("Authorization", "Bearer "+b.token)
	return b.base.RoundTrip(clone)
}

// ExtractBearer returns the bearer token from an inbound request's
// Authorization header, or "" if it is absent or not a Bearer credential.
func ExtractBearer(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if auth == "" {
		return ""
	}
	const prefix = "bearer "
	if len(auth) <= len(prefix) || !strings.EqualFold(auth[:len(prefix)], prefix) {
		return ""
	}
	token := strings.TrimSpace(auth[len(prefix):])
	if token == "" || strings.ContainsAny(token, " \t") {
		return ""
	}
	return token
}
