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
	// (and any client) expects a JSON error. Rooted before cleaning, since
	// path.Clean only resolves ".." against a leading "/" ("../api" stays
	// "../api", and would miss the check just as well).
	cleaned := path.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
	if isAPIPath(cleaned) {
		httpx.WriteError(w, http.StatusNotFound, "NotFound", "not found")
		return
	}
	// ServeFileFS rejects a request whose URL still holds a dot-segment with its
	// own plain-text 400, whatever `name` it is handed — so it gets the cleaned
	// path too, and the normalization above is applied whole. Otherwise
	// "/r/core/v1/../pods" is normalized for the API check, found not to be an
	// API path, and then answered with that 400 instead of index.html.
	r = withPath(r, cleaned)

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

// withPath returns r with its URL path replaced, sharing everything else. The
// request is only read from here on (net/http serves the file itself), so a
// shallow copy is enough — as in httputil's own rewrite path. RawPath goes with
// it: it is the encoded form of the old path, and url.EscapedPath falls back to
// escaping Path once the two no longer agree.
func withPath(r *http.Request, p string) *http.Request {
	if p == r.URL.Path {
		return r
	}
	clone := *r
	u := *r.URL
	u.Path = p
	u.RawPath = ""
	clone.URL = &u
	return &clone
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
