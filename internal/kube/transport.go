package kube

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"k8s.io/client-go/rest"
)

// Upstream bundles the shared credential-free connection to kube-apiserver.
// The Transport carries TLS/CA settings only — never any bearer token. It is
// shared by the gateway, adapters and readiness probe and must never be
// mutated after construction.
type Upstream struct {
	BaseURL    *url.URL
	Transport  http.RoundTripper
	RestConfig *rest.Config
}

// NewUpstream builds the shared transport from a credential-free rest.Config.
func NewUpstream(rc *rest.Config) (*Upstream, error) {
	rt, err := rest.TransportFor(rc)
	if err != nil {
		return nil, fmt.Errorf("build upstream transport: %w", err)
	}
	base, err := parseHost(rc.Host)
	if err != nil {
		return nil, err
	}
	return &Upstream{BaseURL: base, Transport: rt, RestConfig: rc}, nil
}

// parseHost normalizes a rest.Config Host into the upstream base URL. Any
// embedded userinfo is dropped here as well as in stripHostCredentials: this
// URL is what the gateway proxies to, what the readiness probe calls and the
// only URL ever printed, so it must be credential-free no matter which path
// built the config.
func parseHost(host string) (*url.URL, error) {
	if host == "" {
		return nil, fmt.Errorf("upstream host is empty")
	}
	u, err := parseHostURL(host)
	if err != nil {
		return nil, fmt.Errorf("parse upstream host: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported upstream scheme %q", u.Scheme)
	}
	u.User = nil
	u.Path = strings.TrimSuffix(u.Path, "/")
	u.RawQuery = ""
	u.Fragment = ""
	return u, nil
}

// parseHostURL parses a rest.Config Host, whose scheme is optional. The raw
// value never reaches the returned error: url.Error stringifies the URL it
// failed on, which would put a password embedded in the host straight into a
// startup error message.
func parseHostURL(host string) (*url.URL, error) {
	if !strings.Contains(host, "://") {
		host = "https://" + host
	}
	u, err := url.Parse(host)
	if err != nil {
		var uerr *url.Error
		if errors.As(err, &uerr) {
			return nil, uerr.Err
		}
		return nil, errors.New("invalid URL")
	}
	return u, nil
}
