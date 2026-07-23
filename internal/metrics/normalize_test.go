package metrics

import (
	"encoding/json"
	"testing"
)

func TestParseCPU(t *testing.T) {
	cases := map[string]int64{
		"250m":       250_000_000,
		"1":          1_000_000_000,
		"1500m":      1_500_000_000,
		"184563n":    184_563,
		"171000000n": 171_000_000,
		"2u":         2_000,
		"0":          0,
	}
	for in, want := range cases {
		if got := parseCPU(in); got != want {
			t.Errorf("parseCPU(%q) = %d, want %d", in, got, want)
		}
	}
	if got := parseCPU("not-a-quantity"); got != 0 {
		t.Errorf("parseCPU(garbage) = %d, want 0", got)
	}
}

func TestParseMemory(t *testing.T) {
	cases := map[string]int64{
		"129Mi": 135_266_304,
		"1Ki":   1024,
		"1Gi":   1_073_741_824,
		"1000":  1000,
		"1M":    1_000_000,
		"0":     0,
	}
	for in, want := range cases {
		if got := parseMemory(in); got != want {
			t.Errorf("parseMemory(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestParseWindowSeconds(t *testing.T) {
	cases := map[string]int64{
		"30s":   30,
		"1m0s":  60,
		"15s":   15,
		"wrong": 0,
	}
	for in, want := range cases {
		if got := parseWindowSeconds(in); got != want {
			t.Errorf("parseWindowSeconds(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestNormalizePodAggregatesContainers(t *testing.T) {
	raw := `{
		"metadata": {"name": "api-123", "namespace": "default", "uid": "u-1"},
		"timestamp": "2026-07-19T14:25:30Z",
		"window": "30s",
		"containers": [
			{"name": "api", "usage": {"cpu": "171000000n", "memory": "251Mi"}},
			{"name": "sidecar", "usage": {"cpu": "13m", "memory": "17825792"}}
		]
	}`
	var item podMetricsItem
	if err := json.Unmarshal([]byte(raw), &item); err != nil {
		t.Fatal(err)
	}
	got := normalizePod(item)
	if got.Kind != "Pod" || got.Namespace != "default" || got.Name != "api-123" {
		t.Fatalf("identity mismatch: %+v", got)
	}
	wantCPU := int64(171_000_000 + 13_000_000)
	if got.CPUNanoCores != wantCPU {
		t.Errorf("pod cpu = %d, want %d", got.CPUNanoCores, wantCPU)
	}
	wantMem := int64(251*1024*1024 + 17_825_792)
	if got.MemoryBytes != wantMem {
		t.Errorf("pod memory = %d, want %d", got.MemoryBytes, wantMem)
	}
	if len(got.Containers) != 2 || got.Containers[0].Name != "api" {
		t.Fatalf("containers mismatch: %+v", got.Containers)
	}
}

func TestLatestTimestampAndWindow(t *testing.T) {
	ts := latestTimestamp([]string{
		"2026-07-19T14:25:00Z",
		"2026-07-19T14:25:30Z",
		"garbage",
		"2026-07-19T14:24:00Z",
	})
	if ts != "2026-07-19T14:25:30Z" {
		t.Errorf("latestTimestamp = %q", ts)
	}
	if w := maxWindowSeconds([]string{"15s", "1m0s", "30s"}); w != 60 {
		t.Errorf("maxWindowSeconds = %d, want 60", w)
	}
}
