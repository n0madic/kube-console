package gateway

import (
	"net/http"
	"strings"

	"github.com/n0madic/kube-console/internal/kube"
)

// exactStripHeaders are removed from every request forwarded upstream.
var exactStripHeaders = []string{
	"Cookie",
	"Referer",
	"Forwarded",
	"Origin",
	// The context router header is a registry key only; it must never reach
	// the apiserver.
	kube.ContextHeader,
}

// prefixStripHeaders are removed by case-insensitive prefix match.
var prefixStripHeaders = []string{
	"impersonate-",
	"x-remote-",
	"x-forwarded-",
}

// SanitizeHeaders removes browser- and proxy-supplied headers that must never
// reach the kube-apiserver: cookies, impersonation, remote-user and forwarding
// headers. Authorization and content negotiation headers pass through.
func SanitizeHeaders(h http.Header) {
	for _, name := range exactStripHeaders {
		h.Del(name)
	}
	for name := range h {
		lower := strings.ToLower(name)
		for _, prefix := range prefixStripHeaders {
			if strings.HasPrefix(lower, prefix) {
				delete(h, name)
				break
			}
		}
	}
}
