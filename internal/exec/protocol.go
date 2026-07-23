// Package exec implements the safe WebSocket bridge for pod exec. The browser
// authenticates with a first text frame (never via URL/query/subprotocol);
// the token lives only for the duration of the connection.
package exec

import (
	"errors"
	"fmt"
	"regexp"

	"github.com/n0madic/kube-console/internal/kube"
)

const (
	// maxAuthFrameBytes bounds the first (auth) frame; generous because OIDC
	// tokens can reach tens of KiB.
	maxAuthFrameBytes = 64 << 10
	// maxControlFrameBytes bounds post-auth text (control) frames.
	maxControlFrameBytes = 4 << 10
	// maxSessionFrameBytes bounds any frame after auth (stdin paste bursts).
	maxSessionFrameBytes = 1 << 20

	maxCommandArgs = 32
	maxArgBytes    = 4 << 10
	maxTokenBytes  = 48 << 10
)

// dns1123Label: namespaces and containers.
var dns1123Label = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$`)

// dns1123Subdomain: pod names.
var dns1123Subdomain = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$`)

// AuthFrame is the mandatory first text frame from the browser.
type AuthFrame struct {
	Type      string   `json:"type"` // must be "auth"
	Token     string   `json:"token"`
	Context   string   `json:"context,omitempty"`
	Namespace string   `json:"namespace"`
	Pod       string   `json:"pod"`
	Container string   `json:"container,omitempty"`
	Command   []string `json:"command,omitempty"`
}

// ResizeFrame is a post-auth text frame carrying a terminal resize.
type ResizeFrame struct {
	Type string `json:"type"` // "resize"
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// ControlFrame is a backend → browser text frame.
type ControlFrame struct {
	Type    string `json:"type"` // ready | error | exit
	Message string `json:"message,omitempty"`
	Code    *int   `json:"code,omitempty"`
}

var errInvalidAuth = errors.New("invalid auth frame")

// validate checks the auth frame and applies the default command. Error
// messages never echo the token or command contents.
func (a *AuthFrame) validate() error {
	if a.Type != "auth" {
		return fmt.Errorf("%w: first frame must have type \"auth\"", errInvalidAuth)
	}
	if a.Token == "" || len(a.Token) > maxTokenBytes {
		return fmt.Errorf("%w: missing or oversized token", errInvalidAuth)
	}
	// An empty context selects the default. A non-empty one is checked against
	// the shared printable-ASCII charset — never DNS-1123, which would reject
	// legitimate EKS ARN / user@cluster context names. The registry stays
	// authoritative on whether the name actually resolves.
	if a.Context != "" && !kube.ValidContextName(a.Context) {
		return fmt.Errorf("%w: invalid context", errInvalidAuth)
	}
	if !dns1123Label.MatchString(a.Namespace) {
		return fmt.Errorf("%w: invalid namespace", errInvalidAuth)
	}
	if !dns1123Subdomain.MatchString(a.Pod) {
		return fmt.Errorf("%w: invalid pod name", errInvalidAuth)
	}
	if a.Container != "" && !dns1123Label.MatchString(a.Container) {
		return fmt.Errorf("%w: invalid container name", errInvalidAuth)
	}
	if len(a.Command) == 0 {
		a.Command = []string{"/bin/sh"}
	}
	if len(a.Command) > maxCommandArgs {
		return fmt.Errorf("%w: too many command arguments", errInvalidAuth)
	}
	for _, arg := range a.Command {
		if len(arg) > maxArgBytes {
			return fmt.Errorf("%w: command argument too long", errInvalidAuth)
		}
	}
	return nil
}
