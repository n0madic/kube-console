// Package httpx contains small HTTP response helpers shared by the server and
// adapters. Error bodies are shaped like Kubernetes Status objects so the SPA
// can handle gateway-originated and apiserver-originated errors uniformly.
package httpx

import (
	"encoding/json"
	"io"
	"net/http"
)

// Status mirrors the Kubernetes metav1.Status shape for errors produced by
// kube-console itself (policy rejections, upstream connectivity errors, ...).
type Status struct {
	Kind       string `json:"kind"`
	APIVersion string `json:"apiVersion"`
	Status     string `json:"status"`
	Message    string `json:"message"`
	Reason     string `json:"reason,omitempty"`
	Code       int    `json:"code"`
}

// WriteJSON writes v as a JSON response with the given status code.
func WriteJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// CopyUpstreamError forwards an upstream error response (status + body)
// transparently, preserving Kubernetes Status JSON when present. It consumes
// and closes resp.Body: callers must not use the response afterwards.
func CopyUpstreamError(w http.ResponseWriter, resp *http.Response) {
	defer func() {
		// Drain and close so the upstream connection can be reused; without
		// this the body leaks on every non-2xx upstream response.
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, 256<<10))
}

// WriteError writes a Kubernetes-Status-shaped JSON error. message must never
// contain credentials or request bodies.
func WriteError(w http.ResponseWriter, code int, reason, message string) {
	WriteJSON(w, code, Status{
		Kind:       "Status",
		APIVersion: "v1",
		Status:     "Failure",
		Message:    message,
		Reason:     reason,
		Code:       code,
	})
}
