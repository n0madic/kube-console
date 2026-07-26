package kube

import (
	"strings"
	"testing"
)

// The agreement test for the shared DNS-1123 subdomain gate. Both call sites
// (metrics namespace/name, exec pod name) splice the value they check into an
// upstream request path, so the table below is deliberately about the
// boundaries of what may enter one: the length bound, the edge characters and
// the character class. Widening the pattern must fail here rather than only
// showing up as a request built out of something unexpected.
func TestIsDNS1123Subdomain(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"empty", "", false},
		{"single letter", "a", true},
		{"single digit", "0", true},
		{"single dash", "-", false},
		{"single dot", ".", false},
		{"plain name", "api-123", true},
		{"embedded dots", "metrics.k8s.io", true},
		{"leading dash", "-api", false},
		{"trailing dash", "api-", false},
		{"leading dot", ".api", false},
		{"trailing dot", "api.", false},
		{"uppercase", "API", false},
		{"mixed case", "Api", false},
		{"underscore", "bad_ns", false},
		{"space", "bad ns", false},
		{"slash", "ns/pod", false},
		{"dot segment", "..", false},
		{"path traversal", "../etc", false},
		{"query string", "pod?watch=true", false},
		{"percent escape", "pod%2fx", false},
		{"newline", "pod\n", false},
		{"253 bytes", strings.Repeat("a", 253), true},
		{"254 bytes", strings.Repeat("a", 254), false},
		{"253 bytes with dots", strings.Repeat("a.", 126) + "a", true},
		{"254 bytes with dots", strings.Repeat("a.", 126) + "aa", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsDNS1123Subdomain(tc.in); got != tc.want {
				t.Errorf("IsDNS1123Subdomain(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
