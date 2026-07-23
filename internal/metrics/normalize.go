package metrics

import (
	"time"

	"k8s.io/apimachinery/pkg/api/resource"
)

// Wire types of the metrics.k8s.io API (subset used by the adapter).

type metricsUsage struct {
	CPU    string `json:"cpu"`
	Memory string `json:"memory"`
}

type podMetricsItem struct {
	Metadata struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
		UID       string `json:"uid"`
	} `json:"metadata"`
	Timestamp  string `json:"timestamp"`
	Window     string `json:"window"`
	Containers []struct {
		Name  string       `json:"name"`
		Usage metricsUsage `json:"usage"`
	} `json:"containers"`
}

type nodeMetricsItem struct {
	Metadata struct {
		Name string `json:"name"`
		UID  string `json:"uid"`
	} `json:"metadata"`
	Timestamp string       `json:"timestamp"`
	Window    string       `json:"window"`
	Usage     metricsUsage `json:"usage"`
}

// Normalized DTO returned to the SPA.

type ContainerUsage struct {
	Name         string `json:"name"`
	CPUNanoCores int64  `json:"cpuNanoCores"`
	MemoryBytes  int64  `json:"memoryBytes"`
}

type Item struct {
	Kind         string           `json:"kind"`
	Namespace    string           `json:"namespace,omitempty"`
	Name         string           `json:"name"`
	UID          string           `json:"uid,omitempty"`
	CPUNanoCores int64            `json:"cpuNanoCores"`
	MemoryBytes  int64            `json:"memoryBytes"`
	Containers   []ContainerUsage `json:"containers,omitempty"`
}

type Response struct {
	// ObservedAt is the source metric timestamp from the Metrics API — never
	// the backend or browser receive time.
	ObservedAt    string `json:"observedAt"`
	WindowSeconds int64  `json:"windowSeconds"`
	Items         []Item `json:"items"`
}

// parseCPU converts a Kubernetes CPU Quantity (e.g. "250m", "1", "184563n")
// to nanocores.
func parseCPU(s string) int64 {
	q, err := resource.ParseQuantity(s)
	if err != nil {
		return 0
	}
	return q.ScaledValue(resource.Nano)
}

// parseMemory converts a Kubernetes memory Quantity (e.g. "129Mi", "1Gi",
// plain bytes) to bytes.
func parseMemory(s string) int64 {
	q, err := resource.ParseQuantity(s)
	if err != nil {
		return 0
	}
	return q.Value()
}

// parseWindowSeconds converts a metrics window (e.g. "30s", "1m0s") to whole
// seconds.
func parseWindowSeconds(s string) int64 {
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0
	}
	return int64(d.Seconds())
}

func normalizePod(item podMetricsItem) Item {
	out := Item{
		Kind:      "Pod",
		Namespace: item.Metadata.Namespace,
		Name:      item.Metadata.Name,
		UID:       item.Metadata.UID,
	}
	for _, c := range item.Containers {
		cu := ContainerUsage{
			Name:         c.Name,
			CPUNanoCores: parseCPU(c.Usage.CPU),
			MemoryBytes:  parseMemory(c.Usage.Memory),
		}
		out.CPUNanoCores += cu.CPUNanoCores
		out.MemoryBytes += cu.MemoryBytes
		out.Containers = append(out.Containers, cu)
	}
	return out
}

func normalizeNode(item nodeMetricsItem) Item {
	return Item{
		Kind:         "Node",
		Name:         item.Metadata.Name,
		UID:          item.Metadata.UID,
		CPUNanoCores: parseCPU(item.Usage.CPU),
		MemoryBytes:  parseMemory(item.Usage.Memory),
	}
}

// latestTimestamp picks the most recent RFC3339 timestamp; used as the
// response-level observedAt for list endpoints.
func latestTimestamp(timestamps []string) string {
	var best string
	var bestTime time.Time
	for _, ts := range timestamps {
		t, err := time.Parse(time.RFC3339, ts)
		if err != nil {
			continue
		}
		if best == "" || t.After(bestTime) {
			best = ts
			bestTime = t
		}
	}
	return best
}

// maxWindowSeconds picks the largest measurement window among items.
func maxWindowSeconds(windows []string) int64 {
	var max int64
	for _, w := range windows {
		if s := parseWindowSeconds(w); s > max {
			max = s
		}
	}
	return max
}
