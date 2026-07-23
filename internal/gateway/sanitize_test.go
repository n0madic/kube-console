package gateway

import (
	"net/http"
	"testing"
)

func TestSanitizeHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("Cookie", "session=abc")
	h.Set("Referer", "https://evil.example")
	h.Set("Forwarded", "for=1.2.3.4")
	h.Set("Origin", "https://evil.example")
	// Case-insensitive: http.Header canonicalizes, but assert both forms here.
	h.Set("X-Kube-Context", "beta")
	h["x-kube-context"] = []string{"gamma"}
	h.Set("Impersonate-User", "admin")
	h.Set("Impersonate-Group", "system:masters")
	h.Set("Impersonate-Extra-Scope", "everything")
	h.Set("X-Remote-User", "admin")
	h.Set("X-Remote-Group", "system:masters")
	h.Set("X-Forwarded-For", "1.2.3.4")
	h.Set("X-Forwarded-Host", "evil.example")
	h.Set("X-Forwarded-Proto", "https")
	h.Set("Authorization", "Bearer token123")
	h.Set("Accept", "application/json")
	h.Set("Content-Type", "application/json")

	SanitizeHeaders(h)

	removed := []string{
		"Cookie", "Referer", "Forwarded", "Origin",
		"Impersonate-User", "Impersonate-Group", "Impersonate-Extra-Scope",
		"X-Remote-User", "X-Remote-Group",
		"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto",
		"X-Kube-Context", "x-kube-context",
	}
	for _, name := range removed {
		if got := h.Get(name); got != "" {
			t.Errorf("header %s should be removed, got %q", name, got)
		}
	}
	if len(h.Values("X-Kube-Context")) != 0 {
		t.Errorf("X-Kube-Context must be fully stripped, got %v", h.Values("X-Kube-Context"))
	}
	kept := map[string]string{
		"Authorization": "Bearer token123",
		"Accept":        "application/json",
		"Content-Type":  "application/json",
	}
	for name, want := range kept {
		if got := h.Get(name); got != want {
			t.Errorf("header %s = %q, want %q", name, got, want)
		}
	}
}
