package kube

import "regexp"

// dns1123Subdomain is the DNS-1123 subdomain shape: 1–253 bytes of lowercase
// alphanumerics, '-' and '.', beginning and ending with an alphanumeric.
//
// It lives here, compiled once, because every user of it is the gate in front of
// a value this process interpolates into an upstream request path — the metrics
// adapter's namespace/name path parameters (internal/metrics/handler.go) and the
// exec auth frame's pod name (internal/exec/protocol.go). It used to be two
// byte-identical copies in those two packages, which is exactly the shape of
// pattern that drifts: relaxing one of them (an extra character class, a wider
// length bound) breaks no test and no build in the other package, so the two
// gates in front of the same kind of interpolation can disagree with nothing
// saying so. One definition plus the agreement test in names_test.go makes such
// an edit visible.
//
// Deliberately not apimachinery's validation.IsDNS1123Subdomain: that one is
// stricter (it requires dots to separate non-empty labels, so `a..b` and `a.-b`
// are rejected there and accepted here), and swapping it in would change what
// both call sites accept — a behaviour change, not this de-duplication.
var dns1123Subdomain = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$`)

// IsDNS1123Subdomain reports whether s is a valid DNS-1123 subdomain, the shape
// of a Kubernetes object name. Empty is not valid: a caller for which the value
// is optional must check for "" itself, as the metrics adapter's ?namespace=
// does.
func IsDNS1123Subdomain(s string) bool { return dns1123Subdomain.MatchString(s) }

// dns1123Label is the DNS-1123 label shape: 1–63 bytes of lowercase
// alphanumerics and '-', beginning and ending with an alphanumeric. Namespaces,
// container names and resource (plural) names all have it, and every caller is
// a gate in front of an upstream path (exec's auth frame, the MCP tools), so it
// lives beside dns1123Subdomain for the same reason that one does.
var dns1123Label = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$`)

// IsDNS1123Label reports whether s is a valid DNS-1123 label. Empty is not.
func IsDNS1123Label(s string) bool { return dns1123Label.MatchString(s) }

// apiVersion matches an API version name ("v1", "v1beta1", "v2alpha1") — the
// version half of a group/version, never the group. It is the only shape the
// metrics adapter and the MCP tools let into the version segment of a path.
var apiVersion = regexp.MustCompile(`^v[0-9]+((alpha|beta)[0-9]+)?$`)

// IsAPIVersion reports whether s is an API version name.
func IsAPIVersion(s string) bool { return apiVersion.MatchString(s) }
