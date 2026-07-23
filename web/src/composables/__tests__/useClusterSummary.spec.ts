import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"

vi.mock("@/api/k8s", () => ({ fetchNodes: vi.fn(), fetchPodCount: vi.fn() }))
vi.mock("@/api/ui", () => ({ fetchAllNodeMetrics: vi.fn() }))

import { fetchNodes, fetchPodCount } from "@/api/k8s"
import type { K8sObjectList, MetricsResponse } from "@/api/types"
import { fetchAllNodeMetrics } from "@/api/ui"
import { useClusterSummary } from "@/composables/useClusterSummary"

const mockNodes = vi.mocked(fetchNodes)
const mockPods = vi.mocked(fetchPodCount)
const mockMetrics = vi.mocked(fetchAllNodeMetrics)

function nodeList(): K8sObjectList {
  return {
    items: [
      {
        metadata: { name: "n1" },
        status: {
          allocatable: { cpu: "4", memory: "16000000Ki", pods: "110" },
          conditions: [{ type: "Ready", status: "True" }],
        },
      },
      {
        metadata: { name: "n2" },
        status: {
          allocatable: { cpu: "4", memory: "16000000Ki", pods: "110" },
          conditions: [{ type: "Ready", status: "False" }],
        },
      },
    ] as K8sObjectList["items"],
  }
}

const metrics: MetricsResponse = {
  observedAt: "t",
  windowSeconds: 15,
  items: [
    { kind: "Node", name: "n1", cpuNanoCores: 500_000_000, memoryBytes: 1_000_000_000 },
    { kind: "Node", name: "n2", cpuNanoCores: 320_000_000, memoryBytes: 2_030_000_000 },
  ],
}

function useInHost() {
  let summary!: ReturnType<typeof useClusterSummary>
  const Host = defineComponent({
    setup() {
      summary = useClusterSummary()
      return () => h("div")
    },
  })
  mount(Host)
  return summary
}

describe("useClusterSummary", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockNodes.mockReset()
    mockPods.mockReset()
    mockMetrics.mockReset()
  })

  it("aggregates node totals, usage and pod count", async () => {
    mockNodes.mockResolvedValue(nodeList())
    mockPods.mockResolvedValue(31)
    mockMetrics.mockResolvedValue(metrics)

    const summary = useInHost()
    await summary.refresh()

    expect(summary.available.value).toBe(true)
    const d = summary.data.value
    expect(d).not.toBeNull()
    // usedCores non-null is the signal that metrics-server data was present.
    expect(d?.cpu).toEqual({ usedCores: 0.82, totalCores: 8 })
    expect(d?.memory).toEqual({ usedBytes: 3_030_000_000, totalBytes: 2 * 16_000_000 * 1024 })
    expect(d?.pods).toEqual({ count: 31, capacity: 220 })
    expect(d?.nodes).toEqual({ ready: 1, total: 2 })
  })

  it("leaves usage null when metrics-server is unavailable but keeps totals", async () => {
    mockNodes.mockResolvedValue(nodeList())
    mockPods.mockResolvedValue(31)
    mockMetrics.mockRejectedValue(new Error("forbidden"))

    const summary = useInHost()
    await summary.refresh()

    expect(summary.available.value).toBe(true)
    // usedCores null signals metrics-server was unavailable while totals remain.
    expect(summary.data.value?.cpu).toEqual({ usedCores: null, totalCores: 8 })
    expect(summary.data.value?.memory.usedBytes).toBeNull()
    expect(summary.data.value?.pods.count).toBe(31)
  })

  // Regression: refresh() had no per-call guard, so an earlier refresh
  // resolving after a newer one overwrote fresh gauges with a stale snapshot.
  it("discards a slower earlier refresh that resolves after a newer one", async () => {
    let resolveNodes1!: (v: K8sObjectList) => void
    mockNodes.mockImplementationOnce(
      () => new Promise<K8sObjectList>((resolve) => (resolveNodes1 = resolve)),
    )
    mockNodes.mockResolvedValueOnce(nodeList()) // newer refresh: 2 nodes
    mockPods.mockResolvedValue(31)
    mockMetrics.mockRejectedValue(new Error("no metrics"))

    const summary = useInHost()
    const older = summary.refresh() // in flight, will resolve last
    const newer = summary.refresh()
    await newer
    expect(summary.data.value?.nodes.total).toBe(2)

    // The stale single-node snapshot must not overwrite the newer result.
    resolveNodes1({ items: [nodeList().items![0]] } as K8sObjectList)
    await older
    expect(summary.data.value?.nodes.total).toBe(2)
  })

  it("does not write results after stop()", async () => {
    let resolveNodes!: (v: K8sObjectList) => void
    mockNodes.mockImplementation(
      () => new Promise<K8sObjectList>((resolve) => (resolveNodes = resolve)),
    )
    mockPods.mockResolvedValue(31)
    mockMetrics.mockResolvedValue(metrics)

    const summary = useInHost()
    const pending = summary.refresh()
    summary.stop() // unmount while the refresh is in flight
    resolveNodes(nodeList())
    await pending

    expect(summary.data.value).toBeNull()
  })

  it("marks itself unavailable when the node list is forbidden", async () => {
    mockNodes.mockRejectedValue(new Error("forbidden"))
    mockPods.mockResolvedValue(0)
    mockMetrics.mockResolvedValue(metrics)

    const summary = useInHost()
    await summary.refresh()

    expect(summary.available.value).toBe(false)
    expect(summary.data.value).toBeNull()
  })
})
