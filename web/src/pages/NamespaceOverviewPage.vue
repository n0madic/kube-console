<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, triggerRef, watch } from "vue"

import { fetchNamespacePodMetrics } from "@/api/ui"
import type { MetricsItem, MetricsResponse } from "@/api/types"
import RecentEventsCard from "@/components/events/RecentEventsCard.vue"
import ClusterSummaryCards from "@/components/metrics/ClusterSummaryCards.vue"
import MetricsChart from "@/components/metrics/MetricsChart.vue"
import MetricsUnavailable from "@/components/metrics/MetricsUnavailable.vue"
import TopPodsTable from "@/components/metrics/TopPodsTable.vue"
import ProblemPodsCard from "@/components/pod/ProblemPodsCard.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import { useMetricsPolling } from "@/composables/useMetricsPolling"
import { useAuthStore } from "@/stores/auth"
import { usePreferencesStore } from "@/stores/preferences"
import { useUiStore } from "@/stores/ui"
import { getMetricsBuffers } from "@/utils/metricsCache"
import { METRICS_RANGE_OPTIONS, METRICS_RANGE_SECONDS } from "@/utils/metricsRanges"

const ui = useUiStore()
const auth = useAuthStore()
const prefs = usePreferencesStore()
const range = ref(prefs.prefs.metrics.defaultRange)

// Namespace names collide across clusters (e.g. "default"), so the scope key is
// prefixed with the active context.
const cpuKey = () => `${auth.activeContext}:ns:${ui.namespace}:cpu`
const memKey = () => `${auth.activeContext}:ns:${ui.namespace}:mem`
const [initialCpu, initialMem] = getMetricsBuffers(cpuKey(), memKey())
const cpuBuffer = shallowRef(initialCpu)
const memBuffer = shallowRef(initialMem)
const latestItems = shallowRef<MetricsItem[]>([])
/** Problem-pod count from the card below, relayed to the Pods gauge above it
 *  (with the scan's truncation, so the gauge can mark it as a floor). */
const problemPods = ref<number | null>(null)
const problemPodsTruncated = ref(false)

function onProblemCount(count: number | null, truncated: boolean): void {
  problemPods.value = count
  problemPodsTruncated.value = truncated
}

function onSample(resp: MetricsResponse): void {
  const tsMs = Date.parse(resp.observedAt)
  if (Number.isNaN(tsMs)) return
  let cpu = 0
  let mem = 0
  for (const item of resp.items) {
    cpu += item.cpuNanoCores
    mem += item.memoryBytes
  }
  cpuBuffer.value.push(tsMs, { total: cpu })
  memBuffer.value.push(tsMs, { total: mem })
  latestItems.value = resp.items
  triggerRef(cpuBuffer)
  triggerRef(memBuffer)
}

const polling = useMetricsPolling({
  fetcher: () => fetchNamespacePodMetrics(ui.namespace),
  onSample,
})

onMounted(() => void polling.start())

// Namespace switch: rebind to that namespace's cached series (keeping each
// namespace's history alive in the shared cache) and restart polling. The
// TopPods snapshot has no cache, so it still resets. Polling stays stopped
// when the new context has no session — the switcher is already routing to
// /login, and a tokenless capabilities probe would only 401 through the
// global handler, replacing that redirect.
watch(
  () => [ui.namespace, auth.activeContext],
  () => {
    const [cpu, mem] = getMetricsBuffers(cpuKey(), memKey())
    cpuBuffer.value = cpu
    memBuffer.value = mem
    latestItems.value = []
    triggerRef(cpuBuffer)
    triggerRef(memBuffer)
    if (!auth.isAuthenticated) {
      polling.stop()
      return
    }
    void polling.start()
  },
)

// Heading of the namespace-scoped half of the page: it names the current
// namespace filter so the cluster gauges above are visibly not part of it.
const scopeLabel = computed(() => (ui.namespace === "" ? "All namespaces" : ui.namespace))
const cpuData = computed(() => cpuBuffer.value.toUplotData(METRICS_RANGE_SECONDS[range.value]))
const memData = computed(() => memBuffer.value.toUplotData(METRICS_RANGE_SECONDS[range.value]))
// Memoized like the data above (see NodeMetricsTab): a fresh labels() array per
// render re-runs MetricsChart's per-series stats for nothing.
const cpuLabels = computed(() => cpuBuffer.value.labels())
const memLabels = computed(() => memBuffer.value.labels())
</script>

<template>
  <div class="space-y-4 p-4">
    <h1 class="text-xl font-semibold">Overview</h1>

    <!-- The Pods gauge marks the problem pods inside its fill; the count comes
         from the card's scan below, so the cluster is walked once, not twice. -->
    <ClusterSummaryCards
      :problem-pods="problemPods"
      :problem-pods-truncated="problemPodsTruncated"
    />

    <!-- Cluster-wide too (all namespaces, own slow scan); renders only when
         some pod is actually in trouble. -->
    <ProblemPodsCard @count="onProblemCount" />

    <!-- Everything below follows the namespace selector; the heading and the
         rule above it separate it from the cluster-wide gauges, which do not. -->
    <section class="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800">
      <div class="flex items-center gap-2">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {{ scopeLabel }}
        </h2>
        <span class="text-xs text-slate-400">aggregate pod usage · events</span>
        <div class="flex-1"></div>
        <label class="flex items-center gap-1.5 text-sm">
          <span class="text-slate-500 dark:text-slate-400">Range</span>
          <BaseSelect v-model="range">
            <option v-for="opt in METRICS_RANGE_OPTIONS" :key="opt" :value="opt">{{ opt }}</option>
          </BaseSelect>
        </label>
      </div>

      <MetricsUnavailable v-if="polling.state.value !== 'available'" :state="polling.state.value" />
      <template v-else>
        <p v-if="polling.error.value !== null" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {{ polling.error.value }}
        </p>
        <div class="grid gap-4 xl:grid-cols-2">
          <MetricsChart
            title="Aggregate CPU usage"
            unit="cpu"
            :labels="cpuLabels"
            :data="cpuData"
          />
          <MetricsChart
            title="Aggregate memory usage"
            unit="memory"
            :labels="memLabels"
            :data="memData"
          />
        </div>
        <div class="grid gap-4 xl:grid-cols-2">
          <TopPodsTable title="Top pods by CPU" :items="latestItems" sort-by="cpu" />
          <TopPodsTable title="Top pods by memory" :items="latestItems" sort-by="memory" />
        </div>
      </template>

      <RecentEventsCard />
    </section>
  </div>
</template>
