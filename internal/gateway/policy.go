// Package gateway implements the constrained reverse proxy for /k8s/*.
package gateway

import (
	"errors"
	"net/url"
	"strings"
)

// ErrBadPath is returned for malformed or suspicious paths (encoded slashes,
// dot-segments, empty segments, invalid escapes).
var ErrBadPath = errors.New("malformed path")

// ErrForbiddenPath is returned for paths outside the allowlisted roots or
// containing a blocked segment.
var ErrForbiddenPath = errors.New("path not allowed")

// blockedSegments are rejected at any depth. "log" is intentionally allowed.
// Known limitation: an object or resource literally named "exec", "attach",
// "portforward" or "proxy" is unreachable through the gateway.
var blockedSegments = map[string]bool{
	"exec":        true,
	"attach":      true,
	"portforward": true,
	"proxy":       true,
}

// allowedRoots are the only upstream path roots the gateway will forward to.
var allowedRoots = map[string]bool{
	"version": true,
	"api":     true,
	"apis":    true,
	"openapi": true,
}

// CheckPath validates the escaped URL path (with the /k8s prefix already
// stripped). It rejects encoded slashes and dot-segments before any
// interpretation, then applies the root allowlist and per-segment blocklist.
func CheckPath(escaped string) error {
	if escaped == "" || escaped[0] != '/' {
		return ErrBadPath
	}
	lower := strings.ToLower(escaped)
	// Encoded slashes/backslashes could smuggle extra path segments past the
	// segment checks below.
	if strings.Contains(lower, "%2f") || strings.Contains(lower, "%5c") {
		return ErrBadPath
	}
	segments := strings.Split(escaped[1:], "/")
	for _, raw := range segments {
		if raw == "" || raw == "." || raw == ".." {
			return ErrBadPath
		}
		seg, err := url.PathUnescape(raw)
		if err != nil {
			return ErrBadPath
		}
		if seg == "." || seg == ".." {
			return ErrBadPath
		}
		// A single unescape of a legitimate Kubernetes path segment (group,
		// version, resource, DNS-1123 name) never yields a path separator or a
		// residual percent-escape. Their presence means an encoded slash/back-
		// slash (%2f/%5c) or a multiply-encoded payload (e.g. %252f) trying to
		// smuggle extra structure past the per-segment checks below.
		if strings.ContainsAny(seg, "/\\%") {
			return ErrBadPath
		}
		if blockedSegments[strings.ToLower(seg)] {
			return ErrForbiddenPath
		}
	}
	if !allowedRoots[segments[0]] {
		return ErrForbiddenPath
	}
	return nil
}
