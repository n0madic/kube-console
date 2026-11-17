package mcp

import (
	"encoding/base64"
	"fmt"
)

// lastAppliedAnnotation is where client-side `kubectl apply` stores the whole
// manifest it applied — for a Secret, its data or stringData in the clear.
const lastAppliedAnnotation = "kubectl.kubernetes.io/last-applied-configuration"

// redactObject prepares an object for a model's context, in place.
//
// metadata.managedFields is dropped from every kind: it is bookkeeping, often
// larger than the object itself, and costs context for nothing.
//
// A core v1 Secret keeps its keys but not its values: each data/stringData
// value becomes "<redacted: N bytes>" (the decoded size for data), and the
// last-applied annotation is masked whole, since any part of it can already be
// secret material — the same rule the UI's Metadata card follows. There is no
// way to ask for the values: an agent's context is not a place for them, and
// an injected instruction cannot talk a tool into revealing what it never
// returns.
func redactObject(obj map[string]any) {
	md, _ := obj["metadata"].(map[string]any)
	if md != nil {
		delete(md, "managedFields")
	}
	if obj["apiVersion"] != "v1" || obj["kind"] != "Secret" {
		return
	}
	redactValues(obj["data"], true)
	redactValues(obj["stringData"], false)
	if md == nil {
		return
	}
	if ann, ok := md["annotations"].(map[string]any); ok {
		if _, ok := ann[lastAppliedAnnotation]; ok {
			ann[lastAppliedAnnotation] = "<redacted>"
		}
	}
}

func redactValues(field any, base64Encoded bool) {
	values, ok := field.(map[string]any)
	if !ok {
		return
	}
	for k, v := range values {
		s, _ := v.(string)
		n := len(s)
		if base64Encoded {
			if decoded, err := base64.StdEncoding.DecodeString(s); err == nil {
				n = len(decoded)
			}
		}
		values[k] = fmt.Sprintf("<redacted: %d bytes>", n)
	}
}
