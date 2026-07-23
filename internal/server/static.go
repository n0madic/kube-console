package server

import (
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/n0madic/kube-console/internal/httpx"
)

// apiPrefixes are path roots that must never fall back to index.html: they
// answer with JSON errors so that, e.g., a blocked gateway path can never look
// like a successful HTML 200.
var apiPrefixes = []string{"/k8s", "/api", "/healthz", "/readyz"}

// spaHandler serves the embedded SPA: hashed assets with immutable caching,
// index.html (no-store) as the fallback for client-side routes.
type spaHandler struct {
	dist fs.FS
}

// NewSPAHandler builds the static SPA handler over the embedded dist FS.
func NewSPAHandler(dist fs.FS) http.Handler {
	return &spaHandler{dist: dist}
}

func (s *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		httpx.WriteError(w, http.StatusMethodNotAllowed, "MethodNotAllowed", "method not allowed")
		return
	}
	// Cleaned first: chi does not normalize, so "//api/ui/discovery" and
	// "/k8s/../k8s/api" reach here as-is and would otherwise miss the prefix
	// check and be answered with index.html — a 200 HTML body where the SPA
	// (and any client) expects a JSON error.
	cleaned := path.Clean(r.URL.Path)
	if isAPIPath(cleaned) {
		httpx.WriteError(w, http.StatusNotFound, "NotFound", "not found")
		return
	}

	name := strings.TrimPrefix(cleaned, "/")
	if name != "" && name != "index.html" && fileExists(s.dist, name) {
		if strings.HasPrefix(name, "assets/") {
			// Vite emits content-hashed filenames under assets/.
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=300")
		}
		http.ServeFileFS(w, r, s.dist, name)
		return
	}

	if !fileExists(s.dist, "index.html") {
		http.Error(w, "SPA bundle is not embedded in this build", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFileFS(w, r, s.dist, "index.html")
}

func isAPIPath(p string) bool {
	for _, prefix := range apiPrefixes {
		if p == prefix || strings.HasPrefix(p, prefix+"/") {
			return true
		}
	}
	return false
}

func fileExists(fsys fs.FS, name string) bool {
	info, err := fs.Stat(fsys, name)
	return err == nil && !info.IsDir()
}
