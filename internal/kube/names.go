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
