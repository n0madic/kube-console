// Cluster-wide summary for the Overview gauges: node allocatable totals, node
// usage (metrics-server) and an approximate pod count. Visibility-gated
// polling on the same cadence as the metrics charts (mechanics in
// usePollingLoop); all state stays in memory. One loop, but not one cadence:
// the node list is the expensive call and the slow-moving data, so it is fetched
// only when its own snapshot is stale (NODES_INTERVAL_MS) while usage and the
// pod count follow every tick. Node list access failing (e.g. a
// namespace-scoped token) marks the summary unavailable so the caller can hide
// the whole row.

import { ref, watch } from "vue"

import { fetchNodes, fetchPodCount } from "@/api/k8s"
import { fetchAllNodeMetrics } from "@/api/ui"
import type { K8sObject } from "@/api/types"
import { useAuthStore } from "@/stores/auth"
import { usePreferencesStore } from "@/stores/preferences"
import { metricsIntervalMs } from "@/utils/metricsRanges"
import { parseQuantity } from "@/utils/units"

import { usePollingLoop } from "./usePollingLoop"

export interface ClusterSummary {
  // usedCores/usedBytes are null when metrics-server is unavailable/forbidden.
  cpu: { usedCores: number | null; totalCores: number }
  memory: { usedBytes: number | null; totalBytes: number }
  // count is null when the pod list could not be read (RBAC, transient error),
  // exactly like the metrics above: a failed count must not render as a cluster
  // with zero pods, which is a statement the gauge has no basis for.
  pods: { count: number | null; capacity: number }
  nodes: { ready: number; total: number }
}

/**
 * How long a node-list snapshot is reused. Allocatable capacity and Ready
 * counts change when a node joins the cluster or goes down — not on the
 * timescale of a metrics sample — while the node list is by far the most
 * expensive of the three calls: the Kubernetes API cannot project fields out of
 * a list, so every poll transfers the *whole* node objects (~21 KiB each,
 * measured; `status.images` a third of it) to produce four scalars. On the
 * metrics cadence that is ~0.6 MiB/min for 7 nodes and ~8 MiB/min at 100, per
 * open Overview tab, plus a list read per poll on the apiserver. Usage and the
 * pod count keep the metrics cadence: they are the numbers that actually move.
 */
const NODES_INTERVAL_MS = 60_000

interface NodeStatus {
  allocatable?: Record<string, string>
  conditions?: Array<{ type?: string; status?: string }>
}

/** Everything the gauges need from the node list, so a snapshot can be reused
 *  across the metrics-cadence ticks that skip the fetch. */
interface NodeTotals {
  totalCores: number
  totalBytes: number
  podCapacity: number
  ready: number
  total: number
}

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

function nodeTotals(nodes: K8sObject[]): NodeTotals {
  const totals: NodeTotals = {
    totalCores: 0,
    totalBytes: 0,
    podCapacity: 0,
    ready: 0,
    total: nodes.length,
  }
  for (const node of nodes) {
    const alloc = nodeStatus(node).allocatable ?? {}
    totals.totalCores += quantityOrZero(alloc.cpu)
    totals.totalBytes += quantityOrZero(alloc.memory)
    totals.podCapacity += quantityOrZero(alloc.pods)
    if (isNodeReady(node)) totals.ready += 1
  }
  return totals
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

  // The last node snapshot and when the list it came from was requested — the
  // state behind NODES_INTERVAL_MS. Per-cluster, and cleared as such by the
  // context watch below.
  let cachedNodes: NodeTotals | null = null
  let cachedNodesAtMs = 0

  async function refresh(): Promise<void> {
    const req = ++requestSeq
    // Stamped on entry, like usePollingLoop's own throttle: what is bounded is
    // how often the list is *requested*, independent of how long it takes.
    const startedAtMs = Date.now()
    // Always on the first refresh — nothing is cached yet — and once per
    // NODES_INTERVAL_MS after that. A failed attempt leaves the stamp untouched,
    // so the next tick retries at the metrics cadence instead of hiding the
    // gauges for a full minute over one transient error.
    const wantNodes = cachedNodes === null || startedAtMs - cachedNodesAtMs >= NODES_INTERVAL_MS
    const [nodesR, metricsR, podsR] = await Promise.allSettled([
      wantNodes ? fetchNodes() : Promise.resolve(null),
      fetchAllNodeMetrics(),
      fetchPodCount(),
    ])
    // Superseded by a newer refresh or by stop() during the await: discard
    // this stale snapshot (the newer call owns all state writes) — the node
    // cache below included, so a superseded response cannot stamp its own
    // freshness onto the live cluster.
    if (req !== requestSeq) return

    // Without node access there are no totals to show — hide the row. Only an
    // actual attempt can say that: a skipped fetch resolves as null, so this
    // branch still means exactly what it did before.
    if (nodesR.status !== "fulfilled") {
      available.value = false
      return
    }
    let totals = cachedNodes
    if (nodesR.value !== null) {
      totals = nodeTotals(nodesR.value.items ?? [])
      cachedNodes = totals
      cachedNodesAtMs = startedAtMs
      available.value = true
    }
    // Unreachable: wantNodes is true whenever the cache is empty, and a failed
    // attempt returned above. Kept as the type guard for that invariant.
    if (totals === null) return

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

    const podCount = podsR.status === "fulfilled" ? podsR.value : null

    data.value = {
      cpu: { usedCores, totalCores: totals.totalCores },
      memory: { usedBytes, totalBytes: totals.totalBytes },
      pods: { count: podCount, capacity: totals.podCapacity },
      nodes: { ready: totals.ready, total: totals.total },
    }
  }

  function intervalMs(): number {
    return metricsIntervalMs(prefs.prefs.metrics.pollIntervalSeconds)
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
  // switch, so drop the previous cluster's snapshot and restart the loop —
  // stop()+start(), like ProblemPodsCard, because only the loop can stamp its
  // own cadence: a raw refresh() would poll beside the still-armed timer, two
  // full cluster summaries inside one interval. Polling stays stopped when the
  // new context has no session — a tokenless request would only 401.
  watch(
    () => auth.activeContext,
    () => {
      loop.stop()
      data.value = null
      // Allocatable totals and Ready counts describe *a* cluster, so the node
      // cache dies with the snapshot beside it. Not optional: without this the
      // new cluster's first gauge row renders the previous cluster's capacity —
      // and keeps it for up to NODES_INTERVAL_MS, with the new cluster's fresh
      // usage plotted against it, which reads as a real utilisation number
      // rather than as missing data. Deliberately here and not in the loop's
      // onStop hook: every stop() runs that (unmount, and the stop() inside
      // every restart), and none of those changes which cluster the totals are
      // from. Beside `data.value = null` the two pieces of per-cluster state
      // cannot drift.
      cachedNodes = null
      cachedNodesAtMs = 0
      if (!auth.isAuthenticated) return
      void loop.start()
    },
  )

  return { data, available, refresh, start, stop: loop.stop }
}
