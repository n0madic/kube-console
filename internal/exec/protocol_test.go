package exec

import (
	"strings"
	"testing"
)

func validAuth() AuthFrame {
	return AuthFrame{
		Type:      "auth",
		Token:     "user-token",
		Namespace: "default",
		Pod:       "api-123",
		Container: "api",
		Command:   []string{"/bin/sh"},
	}
}

func TestAuthFrameValidateOK(t *testing.T) {
	a := validAuth()
	if err := a.validate(); err != nil {
		t.Fatal(err)
	}
}

func TestAuthFrameDefaultCommand(t *testing.T) {
	a := validAuth()
	a.Command = nil
	if err := a.validate(); err != nil {
		t.Fatal(err)
	}
	if len(a.Command) != 1 || a.Command[0] != "/bin/sh" {
		t.Fatalf("default command = %v, want [/bin/sh]", a.Command)
	}
}

func TestAuthFrameValidateRejects(t *testing.T) {
	cases := map[string]func(*AuthFrame){
		"wrong type":         func(a *AuthFrame) { a.Type = "resize" },
		"empty token":        func(a *AuthFrame) { a.Token = "" },
		"oversized token":    func(a *AuthFrame) { a.Token = strings.Repeat("t", maxTokenBytes+1) },
		"invalid namespace":  func(a *AuthFrame) { a.Namespace = "Bad_NS" },
		"empty namespace":    func(a *AuthFrame) { a.Namespace = "" },
		"invalid pod":        func(a *AuthFrame) { a.Pod = "pod name with spaces" },
		"path traversal pod": func(a *AuthFrame) { a.Pod = "../etc" },
		"invalid container":  func(a *AuthFrame) { a.Container = "UPPER" },
		"too many args": func(a *AuthFrame) {
			a.Command = make([]string, maxCommandArgs+1)
			for i := range a.Command {
				a.Command[i] = "x"
			}
		},
		"oversized arg": func(a *AuthFrame) { a.Command = []string{strings.Repeat("x", maxArgBytes+1)} },
	}
	for name, mutate := range cases {
		a := validAuth()
		mutate(&a)
		if err := a.validate(); err == nil {
			t.Errorf("%s: expected validation error", name)
		}
	}
}

func TestAuthFrameEmptyContainerAllowed(t *testing.T) {
	a := validAuth()
	a.Container = ""
	if err := a.validate(); err != nil {
		t.Fatalf("empty container must be allowed (apiserver picks default): %v", err)
	}
}
