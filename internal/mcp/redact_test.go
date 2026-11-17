package mcp

import (
	"encoding/json"
	"strings"
	"testing"
)

func decode(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestRedactSecret(t *testing.T) {
	obj := decode(t, `{
		"apiVersion": "v1", "kind": "Secret",
		"metadata": {"name": "db", "managedFields": [{"manager": "kubectl"}],
			"annotations": {
				"kubectl.kubernetes.io/last-applied-configuration": "{\"stringData\":{\"password\":\"hunter2\"}}",
				"team": "payments"}},
		"type": "Opaque",
		"data": {"password": "aHVudGVyMg==", "notbase64": "!!"},
		"stringData": {"token": "plain-secret"}
	}`)
	redactObject(obj)
	raw, _ := json.Marshal(obj)
	out := string(raw)
	for _, secret := range []string{"aHVudGVyMg==", "hunter2", "plain-secret", "managedFields"} {
		if strings.Contains(out, secret) {
			t.Errorf("redacted Secret still contains %q: %s", secret, out)
		}
	}
	data := obj["data"].(map[string]any)
	// The keys and the sizes survive: they are what an agent debugging a
	// missing key or an empty value needs, and they reveal no value.
	if data["password"] != "<redacted: 7 bytes>" {
		t.Errorf("data.password = %v", data["password"])
	}
	if data["notbase64"] != "<redacted: 2 bytes>" {
		t.Errorf("data.notbase64 = %v", data["notbase64"])
	}
	if obj["stringData"].(map[string]any)["token"] != "<redacted: 12 bytes>" {
		t.Errorf("stringData.token = %v", obj["stringData"])
	}
	ann := obj["metadata"].(map[string]any)["annotations"].(map[string]any)
	if ann["team"] != "payments" {
		t.Error("an ordinary annotation must survive")
	}
	if ann["kubectl.kubernetes.io/last-applied-configuration"] != "<redacted>" {
		t.Errorf("last-applied = %v", ann["kubectl.kubernetes.io/last-applied-configuration"])
	}
	if obj["type"] != "Opaque" {
		t.Error("non-data fields must survive")
	}
}

func TestRedactLeavesOtherKindsAlone(t *testing.T) {
	const cm = `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"c","managedFields":[{}],
		"annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{}"}},"data":{"k":"v"}}`
	obj := decode(t, cm)
	redactObject(obj)
	if obj["data"].(map[string]any)["k"] != "v" {
		t.Error("ConfigMap data must not be redacted")
	}
	md := obj["metadata"].(map[string]any)
	if _, ok := md["managedFields"]; ok {
		t.Error("managedFields must be dropped from every kind")
	}
	if md["annotations"].(map[string]any)["kubectl.kubernetes.io/last-applied-configuration"] != "{}" {
		t.Error("last-applied is masked on Secrets only")
	}
	// A Secret-named kind in another group is not core Secret.
	other := decode(t, `{"apiVersion":"example.com/v1","kind":"Secret","data":{"k":"v"}}`)
	redactObject(other)
	if other["data"].(map[string]any)["k"] != "v" {
		t.Error("only v1 Secret is redacted")
	}
	// Shapes that are not maps must not panic.
	redactObject(decode(t, `{"apiVersion":"v1","kind":"Secret","metadata":"x","data":["a"],"stringData":null}`))
}
