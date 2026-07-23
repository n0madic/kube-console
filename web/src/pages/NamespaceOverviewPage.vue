<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, triggerRef, watch } from "vue"

import { fetchNamespacePodMetrics } from "@/api/ui"
import type { MetricsItem, MetricsResponse } from "@/api/types"
import RecentEventsCard from "@/components/events/RecentEventsCard.vue"
import ClusterSummaryCards from "@/components/metrics/ClusterSummaryCards.vue"
import MetricsChart from "@/components/metrics/MetricsChart.vue"
import MetricsUnavailable from "@/components/metrics/MetricsUnavailable.vue"
import TopPodsTable from "@/components/metrics/TopPodsTable.vue"
import { useMetricsPolling } from "@/composables/useMetricsPolling"
import { useAuthStore } from "@/stores/auth"
import { usePreferencesStore } from "@/stores/preferences"
import { useUiStore } from "@/stores/ui"
import { getMetricsBuffer } from "@/utils/metricsCache"
import { METRICS_RANGE_OPTIONS, METRICS_RANGE_SECONDS } from "@/utils/metricsRanges"

const ui = useUiStore()
const auth = useAuthStore()
const prefs = usePreferencesStore()
const range = ref(prefs.prefs.metrics.defaultRange)

// Namespace names collide across clusters (e.g. "default"), so the scope key is
// prefixed with the active context.
const cpuKey = () => `${auth.activeContext}:ns:${ui.namespace}:cpu`
const memKey = () => `${auth.activeContext}:ns:${ui.namespace}:mem`
const cpuBuffer = shallowRef(getMetricsBuffer(cpuKey()))
const memBuffer = shallowRef(getMetricsBuffer(memKey()))
const latestItems = shallowRef<MetricsItem[]>([])

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
// TopPods snapshot has no cache, so it still resets.
watch(
  () => [ui.namespace, auth.activeContext],
  () => {
    cpuBuffer.value = getMetricsBuffer(cpuKey())
    memBuffer.value = getMetricsBuffer(memKey())
    latestItems.value = []
    triggerRef(cpuBuffer)
    triggerRef(memBuffer)
    void polling.start()
  },
)

// Heading of the namespace-scoped half of the page: it names the current
// namespace filter so the cluster gauges above are visibly not part of it.
const scopeLabel = computed(() => (ui.namespace === "" ? "All namespaces" : ui.namespace))
const cpuData = computed(() => cpuBuffer.value.toUplotData(METRICS_RANGE_SECONDS[range.value]))
const memData = computed(() => memBuffer.value.toUplotData(METRICS_RANGE_SECONDS[range.value]))
</script>

<template>
  <div class="space-y-4 p-4">
    <h1 class="text-xl font-semibold">Overview</h1>

    <ClusterSummaryCards />

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
          <select
            v-model="range"
            class="rounded-md border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
          >
            <option v-for="opt in METRICS_RANGE_OPTIONS" :key="opt" :value="opt">{{ opt }}</option>
          </select>
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
            :labels="cpuBuffer.labels()"
            :data="cpuData"
          />
          <MetricsChart
            title="Aggregate memory usage"
            unit="memory"
            :labels="memBuffer.labels()"
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
