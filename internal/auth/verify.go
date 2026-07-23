// Package auth validates a user's bearer token by performing a
// SelfSubjectReview against the kube-apiserver. It backs POST
// /api/ui/auth/verify and is reused by every adapter that must not answer
// before knowing the caller holds a real token.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/n0madic/kube-console/internal/httpx"
	"github.com/n0madic/kube-console/internal/kube"
)

// Errors returned by VerifyToken. Callers map them to a response; neither is
// ever written to the client verbatim.
var (
	// ErrInvalidToken means the apiserver rejected the token (401).
	ErrInvalidToken = errors.New("invalid or expired token")
	// ErrUpstream means the apiserver could not be reached or answered in a
	// way we cannot interpret. It says nothing about the token.
	ErrUpstream = errors.New("kube-apiserver unavailable")
)

// Verification is the outcome of a successful SelfSubjectReview: the token is
// valid, and the identity is filled in unless the user may not read it.
type Verification struct {
	Identity *Identity
	// IdentityUnavailable is set when the token works but the user may not
	// call SelfSubjectReview (403). Callers proceed: real RBAC is enforced on
	// every subsequent API request anyway.
	IdentityUnavailable bool
}

// VerifyToken checks a bearer token against one cluster by asking the
// apiserver who the caller is. It is the only thing standing between an
// unauthenticated client and the adapters, so it is deliberately the same call
// the login flow makes: no local session state, no token cache, no way for the
// answer to drift from what the apiserver would decide on the next request.
func VerifyToken(ctx context.Context, up *kube.Upstream, token string) (*Verification, error) {
	body := strings.NewReader(`{"apiVersion":"authentication.k8s.io/v1","kind":"SelfSubjectReview"}`)
	header := http.Header{}
	header.Set("Content-Type", "application/json")
	header.Set("Accept", "application/json")
	ctx, cancel := context.WithTimeout(ctx, upstreamTimeout)
	defer cancel()
	resp, err := kube.Do(ctx, up, token, http.MethodPost, selfSubjectReviewPath, header, body)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUpstream, err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	switch resp.StatusCode {
	case http.StatusOK, http.StatusCreated:
		var review selfSubjectReview
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&review); err != nil {
			return nil, fmt.Errorf("%w: unexpected SelfSubjectReview response", ErrUpstream)
		}
		return &Verification{Identity: &Identity{
			Username: review.Status.UserInfo.Username,
			UID:      review.Status.UserInfo.UID,
			Groups:   review.Status.UserInfo.Groups,
		}}, nil
	case http.StatusUnauthorized:
		return nil, ErrInvalidToken
	case http.StatusForbidden:
		// Valid token, no permission to introspect it.
		return &Verification{IdentityUnavailable: true}, nil
	default:
		return nil, fmt.Errorf("%w: unexpected SelfSubjectReview status %d", ErrUpstream, resp.StatusCode)
	}
}

// WriteError maps a VerifyToken error onto the response. Every adapter that
// gates on a token uses it, so an expired token is always a 401 the SPA's
// logout path recognizes, never a 502 that just breaks the view.
func WriteError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrInvalidToken) {
		httpx.WriteError(w, http.StatusUnauthorized, "Unauthorized", "invalid or expired token")
		return
	}
	httpx.WriteError(w, http.StatusBadGateway, "ServiceUnavailable", "kube-apiserver is unreachable")
}

// LogAndWriteError is WriteError plus the one log line every gated adapter
// wants: a rejected token is routine and stays out of the log, anything else is
// a warning naming the context it happened on.
func LogAndWriteError(w http.ResponseWriter, logger *slog.Logger, contextName string, err error) {
	if !errors.Is(err, ErrInvalidToken) {
		logger.Warn("token verification failed", "context", contextName, "error", err)
	}
	WriteError(w, err)
}

const selfSubjectReviewPath = "/apis/authentication.k8s.io/v1/selfsubjectreviews"

// upstreamTimeout bounds the SelfSubjectReview call. A variable so tests can
// shorten it; see kube.DefaultUnaryTimeout for the rationale.
var upstreamTimeout = kube.DefaultUnaryTimeout

// Identity describes the authenticated user as reported by the apiserver.
type Identity struct {
	Username string   `json:"username"`
	UID      string   `json:"uid,omitempty"`
	Groups   []string `json:"groups,omitempty"`
}

// VerifyResponse is the adapter's response DTO.
type VerifyResponse struct {
	Authenticated bool      `json:"authenticated"`
	Identity      *Identity `json:"identity,omitempty"`
	// IdentityUnavailable is set when the token works but the user may not
	// call SelfSubjectReview (403). The UI proceeds: real RBAC is enforced on
	// every subsequent API request anyway.
	IdentityUnavailable bool `json:"identityUnavailable,omitempty"`
	// Context is the resolved context name the token was verified against. On
	// the first login the frontend has no context list yet, so it stores the
	// new session under this name.
	Context string `json:"context,omitempty"`
}

type selfSubjectReview struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Status     struct {
		UserInfo struct {
			Username string   `json:"username"`
			UID      string   `json:"uid"`
			Groups   []string `json:"groups"`
		} `json:"userInfo"`
	} `json:"status"`
}

// Handler serves POST /api/ui/auth/verify.
type Handler struct {
	registry *kube.Registry
	logger   *slog.Logger
}

// NewHandler builds the auth verify handler.
func NewHandler(reg *kube.Registry, logger *slog.Logger) *Handler {
	return &Handler{registry: reg, logger: logger}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	token := kube.ExtractBearer(r)
	if token == "" {
		httpx.WriteError(w, http.StatusUnauthorized, "Unauthorized", "missing bearer token")
		return
	}
	up, contextName, ok := h.registry.ResolveRequest(w, r)
	if !ok {
		return
	}

	verified, err := VerifyToken(r.Context(), up, token)
	if err != nil {
		LogAndWriteError(w, h.logger, contextName, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, VerifyResponse{
		Authenticated:       true,
		Identity:            verified.Identity,
		IdentityUnavailable: verified.IdentityUnavailable,
		Context:             contextName,
	})
}
