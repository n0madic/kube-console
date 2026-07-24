<script setup lang="ts">
// Cluster-wide problem pods for the Overview's global view: the same Table the
// pods list page renders (server-computed Ready/Status/Restarts/Age columns),
// walked across all namespaces and filtered by utils/podHealth.
//
// The scan is deliberately unfiltered server-side: the most important case,
// CrashLoopBackOff, has phase=Running, so no field selector can express "not
// healthy". It is bounded instead (MAX_PAGES × PAGE_LIMIT) and polled on its
// own slow cadence — the metrics cadence would mean a full pod walk every 15s
// — with a Refresh button for on-demand checks.
//
// The card renders nothing at all when no pod is in trouble, and hides itself
// on a 403: listing pods cluster-wide needs cluster RBAC, and a
// namespace-scoped token must not turn the Overview into a permission error.
// It ignores the namespace selector, like the gauges above it.

import { computed, onMounted, ref, watch } from "vue"

import { asApiError, messageFromError } from "@/api/http"
import { listAllAsTable } from "@/api/k8s"
import type { K8sTableRow, ResourceRef } from "@/api/types"
import ResourceMiniTable from "@/components/detail/ResourceMiniTable.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import { usePollingLoop } from "@/composables/usePollingLoop"
import { useAuthStore } from "@/stores/auth"
import { tableToMini, type MiniRow } from "@/utils/miniTable"
import { podColumnIndexes, podProblem, PROBLEM_RANK } from "@/utils/podHealth"

const PODS_REF: ResourceRef = { group: "", version: "v1", resource: "pods" }
// Server columns worth showing, in kubectl order; Name comes from the row link
// and the namespace from row metadata. Node is one of the printer's wide
// columns (`keepOnly` takes those too) and earns its width here: a column of
// failures sharing one node is the diagnosis.
const SHOWN_COLUMNS = ["Ready", "Status", "Restarts", "Age", "Node"]
const PAGE_LIMIT = 500
const MAX_PAGES = 6
/** Cap on rendered rows — a cluster in real trouble must not print thousands. */
const MAX_ROWS = 50
const REFRESH_INTERVAL_MS = 60_000

const auth = useAuthStore()

const columns = ref<string[]>([])
const rows = ref<MiniRow[]>([])
/** Matches found before the display cap. */
const matchCount = ref(0)
/** The bounded scan hit its page cap: more pods exist that were never examined. */
const scanTruncated = ref(false)
const loading = ref(false)
const errorText = ref<string | null>(null)

function reset(): void {
  columns.value = []
  rows.value = []
  matchCount.value = 0
  scanTruncated.value = false
  errorText.value = null
}

// Monotonic id per scan, on top of the loop's generation: the loop's
// visibilitychange catch-up starts a scan without knowing one is already
// walking, and both carry the *same* live generation, so a slower earlier scan
// would overwrite the newer rows and clear `loading` under it. Bumped by the
// loop's onStop hook too, which is how a scan outstanding across a stop() is
// dropped (useClusterSummary guards the same overlap the same way).
let scanSeq = 0

async function tick(gen: number): Promise<void> {
  if (document.hidden) return
  const scan = ++scanSeq
  // Superseded by a restart (Refresh, context switch), by unmount or by an
  // overlapping scan: the newer one owns all state writes.
  const current = (): boolean => loop.isCurrent(gen) && scan === scanSeq
  loading.value = true
  try {
    const result = await listAllAsTable(PODS_REF, { limit: PAGE_LIMIT, maxPages: MAX_PAGES })
    if (!current()) return
    const defs = result.table.columnDefinitions ?? []
    const cols = podColumnIndexes(defs)
    const now = Date.now()
    const matched = (result.table.rows ?? [])
      .flatMap((row: K8sTableRow) => {
        const problem = podProblem(row, cols, now)
        return problem === null ? [] : [{ row, problem }]
      })
      .sort(
        (a, b) =>
          PROBLEM_RANK[a.problem] - PROBLEM_RANK[b.problem] ||
          (a.row.object?.metadata?.namespace ?? "").localeCompare(
            b.row.object?.metadata?.namespace ?? "",
          ) ||
          (a.row.object?.metadata?.name ?? "").localeCompare(b.row.object?.metadata?.name ?? ""),
      )
    // tableToMini preserves row order, so the sort above is what the cap keeps.
    const mini = tableToMini(
      {
        kind: "Table",
        columnDefinitions: defs,
        rows: matched.slice(0, MAX_ROWS).map((m) => m.row),
      },
      { keepOnly: SHOWN_COLUMNS },
    )
    columns.value = mini.columns
    rows.value = mini.rows
    matchCount.value = matched.length
    scanTruncated.value = result.truncated
    errorText.value = null
  } catch (e) {
    if (!current()) return
    rows.value = []
    matchCount.value = 0
    // A namespace-scoped token simply cannot answer this question, so a 403
    // leaves the card in its invisible state (no rows, no error) instead of
    // turning the Overview into a permission error on every visit.
    errorText.value = asApiError(e).status === 403 ? null : messageFromError(e)
  } finally {
    if (current()) loading.value = false
  }
}

const loop = usePollingLoop(tick, () => REFRESH_INTERVAL_MS, () => {
  scanSeq += 1 // invalidate any scan still in flight
})

onMounted(() => void loop.start())

// Follow the active cluster: the Overview stays mounted across a context
// switch, so drop the previous cluster's rows and rescan — unless the new
// context has no session, where a tokenless request would only 401.
watch(
  () => auth.activeContext,
  () => {
    loop.stop()
    reset()
    loading.value = false
    if (!auth.isAuthenticated) return
    void loop.start()
  },
)

/** Refresh restarts the loop, so the next automatic scan is a full interval away. */
function refresh(): void {
  void loop.start()
}

const hasMore = computed(() => matchCount.value > rows.value.length)
const visible = computed(() => rows.value.length > 0 || errorText.value !== null)
</script>

<template>
  <section
    v-if="visible"
    class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
  >
    <div class="mb-3 flex items-center justify-between gap-3">
      <div class="flex items-baseline gap-2">
        <h3 class="text-sm font-semibold">
          Problem pods<span v-if="rows.length > 0" class="ml-1 font-normal text-slate-400">
            ({{ hasMore ? `${rows.length} of ${matchCount}` : rows.length
            }}{{ scanTruncated ? "+" : "" }})</span>
        </h3>
        <span class="text-xs text-slate-400">
          all namespaces · failing, not ready or stuck &gt; 15m
        </span>
      </div>
      <BaseButton :disabled="loading" @click="refresh">
        {{ loading ? "Loading..." : "Refresh" }}
      </BaseButton>
    </div>

    <p
      v-if="errorText !== null"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
    >
      {{ errorText }}
    </p>
    <ResourceMiniTable
      v-else
      :link-ref="PODS_REF"
      :columns="columns"
      :rows="rows"
      show-namespace
    />
  </section>
</template>
