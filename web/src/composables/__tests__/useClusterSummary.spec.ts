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
import { useAuthStore } from "@/stores/auth"

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

/** A deliberately different cluster: every total differs from nodeList()'s, so
 *  a leaked snapshot cannot pass for the new cluster's own numbers. */
function otherNodeList(): K8sObjectList {
  return {
    items: [
      {
        metadata: { name: "b1" },
        status: {
          allocatable: { cpu: "32", memory: "64000000Ki", pods: "250" },
          conditions: [{ type: "Ready", status: "True" }],
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

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
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
    // Sessions live in sessionStorage and would survive the pinia reset into
    // the next test's auth store.
    window.sessionStorage.clear()
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

  // Regression: the context watch called the raw refresh(), which the loop
  // only wraps — nothing outside usePollingLoop can stamp its cadence, so the
  // timer armed before the switch still fired on the old schedule: a switch at
  // t=12s polled at 0s, 12s AND 15s — two full cluster summaries 3s apart.
  //
  // Polls are counted through fetchAllNodeMetrics, not fetchNodes: the node list
  // has its own slower interval and is skipped on most ticks.
  it("restarts the polling cadence on a context switch instead of polling beside it", async () => {
    vi.useFakeTimers()
    try {
      mockNodes.mockResolvedValue(nodeList())
      mockPods.mockResolvedValue(31)
      mockMetrics.mockResolvedValue(metrics)
      const auth = useAuthStore()
      auth.setSession("alpha", "tok-alpha", null, false)

      const summary = useInHost()
      summary.start()
      await flush()
      expect(mockMetrics).toHaveBeenCalledTimes(1) // t=0

      await vi.advanceTimersByTimeAsync(12_000) // 15s interval floor: no poll yet
      expect(mockMetrics).toHaveBeenCalledTimes(1)
      auth.setSession("beta", "tok-beta", null, false) // switch → immediate poll
      await flush()
      expect(mockMetrics).toHaveBeenCalledTimes(2) // t=12s

      // The pre-switch timer (armed for t=15s) must be gone …
      await vi.advanceTimersByTimeAsync(5_000) // t=17s
      expect(mockMetrics).toHaveBeenCalledTimes(2)
      // … and the next poll comes one full interval after the switch.
      await vi.advanceTimersByTimeAsync(10_000) // t=27s
      expect(mockMetrics).toHaveBeenCalledTimes(3)
      summary.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // The node list is the summary's expensive call (whole node objects — the API
  // cannot project fields out of a list) and its slow-moving data, so it has its
  // own 60s interval inside the single polling loop.
  it("fetches the node list on its own slower interval, usage every tick", async () => {
    vi.useFakeTimers()
    try {
      mockNodes.mockResolvedValue(nodeList())
      mockPods.mockResolvedValue(31)
      mockMetrics.mockResolvedValue(metrics)
      const auth = useAuthStore()
      auth.setSession("alpha", "tok-alpha", null, false)

      const summary = useInHost()
      summary.start()
      await flush()
      // The first refresh has nothing cached, so it always fetches.
      expect(mockNodes).toHaveBeenCalledTimes(1)
      expect(mockMetrics).toHaveBeenCalledTimes(1)

      // t=15s/30s/45s: three more metrics-cadence polls, still one node list.
      await vi.advanceTimersByTimeAsync(45_000)
      expect(mockMetrics).toHaveBeenCalledTimes(4)
      expect(mockPods).toHaveBeenCalledTimes(4)
      expect(mockNodes).toHaveBeenCalledTimes(1)

      // t=60s: the node interval has elapsed, so this tick fetches the list too.
      await vi.advanceTimersByTimeAsync(15_000)
      expect(mockMetrics).toHaveBeenCalledTimes(5)
      expect(mockNodes).toHaveBeenCalledTimes(2)
      summary.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("renders the cached node totals on a tick that skipped the node list", async () => {
    vi.useFakeTimers()
    try {
      // A second node list would change every total — it must never be read.
      mockNodes.mockResolvedValueOnce(nodeList()).mockResolvedValue(otherNodeList())
      mockPods.mockResolvedValueOnce(31).mockResolvedValue(35)
      mockMetrics.mockResolvedValueOnce(metrics).mockResolvedValue({
        ...metrics,
        items: [
          { kind: "Node", name: "n1", cpuNanoCores: 1_000_000_000, memoryBytes: 4_000_000_000 },
        ],
      })
      const auth = useAuthStore()
      auth.setSession("alpha", "tok-alpha", null, false)

      const summary = useInHost()
      summary.start()
      await flush()
      await vi.advanceTimersByTimeAsync(15_000) // second tick: cached nodes
      expect(mockNodes).toHaveBeenCalledTimes(1)

      const d = summary.data.value
      expect(summary.available.value).toBe(true)
      // Usage and the pod count are the fresh tick's …
      expect(d?.cpu.usedCores).toBe(1)
      expect(d?.memory.usedBytes).toBe(4_000_000_000)
      expect(d?.pods.count).toBe(35)
      // … while every node-derived total is the one node fetch's.
      expect(d?.cpu.totalCores).toBe(8)
      expect(d?.memory.totalBytes).toBe(2 * 16_000_000 * 1024)
      expect(d?.pods.capacity).toBe(220)
      expect(d?.nodes).toEqual({ ready: 1, total: 2 })
      summary.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // Allocatable capacity and Ready counts are per-cluster: reusing them across a
  // switch would render the previous cluster's capacity under the new cluster's
  // usage for up to a full node interval.
  it("refetches the node list on a context switch instead of reusing the cache", async () => {
    vi.useFakeTimers()
    try {
      mockNodes.mockResolvedValueOnce(nodeList()).mockResolvedValue(otherNodeList())
      mockPods.mockResolvedValue(31)
      mockMetrics.mockResolvedValue(metrics)
      const auth = useAuthStore()
      auth.setSession("alpha", "tok-alpha", null, false)

      const summary = useInHost()
      summary.start()
      await flush()
      expect(summary.data.value?.cpu.totalCores).toBe(8)

      // Well inside the node interval, so only a per-cluster reset can refetch.
      await vi.advanceTimersByTimeAsync(12_000)
      auth.setSession("beta", "tok-beta", null, false)
      await flush()

      expect(mockNodes).toHaveBeenCalledTimes(2)
      const d = summary.data.value
      expect(d?.cpu.totalCores).toBe(32)
      expect(d?.memory.totalBytes).toBe(64_000_000 * 1024)
      expect(d?.pods.capacity).toBe(250)
      expect(d?.nodes).toEqual({ ready: 1, total: 1 })
      summary.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // A failed attempt must not stamp the node interval: the gauges are hidden
  // until it succeeds, so waiting out a full minute over one transient error
  // would keep the row off screen for that long.
  it("retries the node list on the next tick after a failed fetch", async () => {
    vi.useFakeTimers()
    try {
      mockNodes.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(nodeList())
      mockPods.mockResolvedValue(31)
      mockMetrics.mockResolvedValue(metrics)
      const auth = useAuthStore()
      auth.setSession("alpha", "tok-alpha", null, false)

      const summary = useInHost()
      summary.start()
      await flush()
      expect(summary.available.value).toBe(false)
      expect(summary.data.value).toBeNull()

      await vi.advanceTimersByTimeAsync(15_000)
      expect(mockNodes).toHaveBeenCalledTimes(2)
      expect(summary.available.value).toBe(true)
      expect(summary.data.value?.cpu.totalCores).toBe(8)
      summary.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops polling on a switch to a context with no session", async () => {
    vi.useFakeTimers()
    try {
      mockNodes.mockResolvedValue(nodeList())
      mockPods.mockResolvedValue(31)
      mockMetrics.mockResolvedValue(metrics)
      const auth = useAuthStore()
      auth.setSession("alpha", "tok-alpha", null, false)

      const summary = useInHost()
      summary.start()
      await flush()
      expect(mockNodes).toHaveBeenCalledTimes(1)
      expect(summary.data.value).not.toBeNull()

      auth.setActiveContext("beta") // no session for beta
      await flush()
      expect(summary.data.value).toBeNull()

      // Neither an immediate tokenless poll nor a later one from the old timer.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mockNodes).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
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

  // Regression: a failed pod count fell back to 0, so an RBAC denial or a
  // transient error rendered as "0 / 220" with an empty ring — a statement
  // about the cluster the gauge had no basis for. Unknown is null, like the
  // metrics-server values beside it.
  it("leaves the pod count null when the count could not be read", async () => {
    mockNodes.mockResolvedValue(nodeList())
    mockPods.mockRejectedValue(new Error("forbidden"))
    mockMetrics.mockResolvedValue(metrics)

    const summary = useInHost()
    await summary.refresh()

    expect(summary.available.value).toBe(true)
    expect(summary.data.value?.pods).toEqual({ count: null, capacity: 220 })
  })
})
