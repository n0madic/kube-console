// Cluster-wide summary for the Overview gauges: node allocatable totals, node
// usage (metrics-server) and an approximate pod count. Visibility-gated
// polling on the same cadence as the metrics charts (mechanics in
// usePollingLoop); all state stays in memory. Node list access failing (e.g. a
// namespace-scoped token) marks the summary unavailable so the caller can hide
// the whole row.

import { ref, watch } from "vue"

import { fetchNodes, fetchPodCount } from "@/api/k8s"
import { fetchAllNodeMetrics } from "@/api/ui"
import type { K8sObject } from "@/api/types"
import { useAuthStore } from "@/stores/auth"
import { usePreferencesStore } from "@/stores/preferences"
import { parseQuantity } from "@/utils/units"

import { usePollingLoop } from "./usePollingLoop"

export interface ClusterSummary {
  // usedCores/usedBytes are null when metrics-server is unavailable/forbidden.
  cpu: { usedCores: number | null; totalCores: number }
  memory: { usedBytes: number | null; totalBytes: number }
  pods: { count: number; capacity: number }
  nodes: { ready: number; total: number }
}

interface NodeStatus {
  allocatable?: Record<string, string>
  conditions?: Array<{ type?: string; status?: string }>
}

const MIN_INTERVAL_SECONDS = 15

function nodeStatus(node: K8sObject): NodeStatus {
  return (node.status as NodeStatus | undefined) ?? {}
}

function isNodeReady(node: K8sObject): boolean {
  const conditions = nodeStatus(node).conditions ?? []
  return conditions.some((c) => c.type === "Ready" && c.status === "True")
}

/** parseQuantity, treating NaN (missing/unparseable) as 0 for summation. */
function quantityOrZero(value: string | undefined): number {
  const n = parseQuantity(value)
  return Number.isNaN(n) ? 0 : n
}

export function useClusterSummary() {
  const auth = useAuthStore()
  const prefs = usePreferencesStore()
  const data = ref<ClusterSummary | null>(null)
  const available = ref(true)

  // Monotonic id per refresh call: a slower earlier response must never
  // overwrite the result of a newer one (overlapping poll + visibilitychange),
  // and a refresh in flight across stop() must not write after unmount — the
  // loop's onStop bumps it, so post-stop responses are dropped.
  let requestSeq = 0

  async function refresh(): Promise<void> {
    const req = ++requestSeq
    const [nodesR, metricsR, podsR] = await Promise.allSettled([
      fetchNodes(),
      fetchAllNodeMetrics(),
      fetchPodCount(),
    ])
    // Superseded by a newer refresh or by stop() during the await: discard
    // this stale snapshot (the newer call owns all state writes).
    if (req !== requestSeq) return

    // Without node access there are no totals to show — hide the row.
    if (nodesR.status !== "fulfilled") {
      available.value = false
      return
    }
    available.value = true

    const nodes = nodesR.value.items ?? []
    let totalCores = 0
    let totalBytes = 0
    let podCapacity = 0
    let ready = 0
    for (const node of nodes) {
      const alloc = nodeStatus(node).allocatable ?? {}
      totalCores += quantityOrZero(alloc.cpu)
      totalBytes += quantityOrZero(alloc.memory)
      podCapacity += quantityOrZero(alloc.pods)
      if (isNodeReady(node)) ready += 1
    }

    let usedCores: number | null = null
    let usedBytes: number | null = null
    if (metricsR.status === "fulfilled") {
      let cpu = 0
      let mem = 0
      for (const item of metricsR.value.items) {
        cpu += item.cpuNanoCores
        mem += item.memoryBytes
      }
      usedCores = cpu / 1_000_000_000
      usedBytes = mem
    }

    const podCount = podsR.status === "fulfilled" ? podsR.value : 0

    data.value = {
      cpu: { usedCores, totalCores },
      memory: { usedBytes, totalBytes },
      pods: { count: podCount, capacity: podCapacity },
      nodes: { ready, total: nodes.length },
    }
  }

  function intervalMs(): number {
    return Math.max(MIN_INTERVAL_SECONDS, prefs.prefs.metrics.pollIntervalSeconds) * 1000
  }

  const loop = usePollingLoop(
    () => refresh(),
    intervalMs,
    () => {
      requestSeq += 1 // invalidate any refresh still in flight
    },
  )

  function start(): void {
    void loop.start()
  }

  // Follow the active cluster: the Overview stays mounted across a context
  // switch, so drop the previous cluster's snapshot and refetch immediately
  // (subsequent polls already carry the new context header). Skipped when the
  // new context has no session — a tokenless request would only 401.
  watch(
    () => auth.activeContext,
    () => {
      data.value = null
      if (!auth.isAuthenticated) return
      void refresh()
    },
  )

  return { data, available, refresh, start, stop: loop.stop }
}
