<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, triggerRef, watch } from "vue"

import { fetchPodMetrics } from "@/api/ui"
import type { K8sObject, MetricsResponse } from "@/api/types"
import MetricsChart from "@/components/metrics/MetricsChart.vue"
import MetricsUnavailable from "@/components/metrics/MetricsUnavailable.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import { useMetricsPolling } from "@/composables/useMetricsPolling"
import { useAuthStore } from "@/stores/auth"
import { usePreferencesStore } from "@/stores/preferences"
import { getMetricsBuffer } from "@/utils/metricsCache"
import { METRICS_RANGE_OPTIONS, METRICS_RANGE_SECONDS } from "@/utils/metricsRanges"
import { podMetricsSeries } from "@/utils/podMetricsSeries"

const props = defineProps<{ object: K8sObject }>()

const auth = useAuthStore()
const prefs = usePreferencesStore()
const range = ref(prefs.prefs.metrics.defaultRange)

// Scope keys are prefixed with the active context so a late response from the
// previous cluster never lands in the new cluster's buffer.
const cpuKey = () => `${auth.activeContext}:pod:${props.object.metadata?.uid ?? ""}:cpu`
const memKey = () => `${auth.activeContext}:pod:${props.object.metadata?.uid ?? ""}:mem`
const cpuBuffer = shallowRef(getMetricsBuffer(cpuKey()))
const memBuffer = shallowRef(getMetricsBuffer(memKey()))

const MAX_CONTAINER_SERIES = 5

function onSample(resp: MetricsResponse): void {
  const item = resp.items[0]
  if (item === undefined) return
  const tsMs = Date.parse(resp.observedAt)
  if (Number.isNaN(tsMs)) return

  const { cpu, mem } = podMetricsSeries(item, MAX_CONTAINER_SERIES)
  cpuBuffer.value.push(tsMs, cpu)
  memBuffer.value.push(tsMs, mem)
  triggerRef(cpuBuffer)
  triggerRef(memBuffer)
}

const polling = useMetricsPolling({
  fetcher: () => {
    const meta = props.object.metadata
    return fetchPodMetrics(meta?.namespace ?? "", meta?.name ?? "")
  },
  onSample,
})

onMounted(() => void polling.start())

// The detail page reuses this component across pod navigations, so an in-place
// pod change must rebind to that pod's cached buffers and restart polling —
// otherwise the charts blend both pods' series. Rebinding (vs. clearing) keeps
// each pod's history alive in the shared cache.
watch(
  () => [props.object.metadata?.uid, auth.activeContext],
  () => {
    cpuBuffer.value = getMetricsBuffer(cpuKey())
    memBuffer.value = getMetricsBuffer(memKey())
    triggerRef(cpuBuffer)
    triggerRef(memBuffer)
    void polling.start()
  },
)

const cpuData = computed(() => cpuBuffer.value.toUplotData(METRICS_RANGE_SECONDS[range.value]))
const memData = computed(() => memBuffer.value.toUplotData(METRICS_RANGE_SECONDS[range.value]))
const cpuLabels = computed(() => cpuBuffer.value.labels())
const memLabels = computed(() => memBuffer.value.labels())
</script>

<template>
  <div class="space-y-4">
    <MetricsUnavailable v-if="polling.state.value !== 'available'" :state="polling.state.value" />
    <template v-else>
      <div class="flex items-center gap-3 text-sm">
        <label class="flex items-center gap-1.5">
          <span class="text-slate-500 dark:text-slate-400">Range</span>
          <BaseSelect v-model="range">
            <option v-for="opt in METRICS_RANGE_OPTIONS" :key="opt" :value="opt">{{ opt }}</option>
          </BaseSelect>
        </label>
        <label class="flex items-center gap-1.5">
          <span class="text-slate-500 dark:text-slate-400">Poll every</span>
          <!-- No `.number`: the options bind real numbers, so the model never
               sees the string form a `.number` modifier would coerce back. -->
          <BaseSelect v-model="prefs.prefs.metrics.pollIntervalSeconds">
            <option :value="15">15s</option>
            <option :value="30">30s</option>
            <option :value="60">60s</option>
          </BaseSelect>
        </label>
        <span v-if="polling.error.value !== null" class="text-xs text-red-500">
          {{ polling.error.value }}
        </span>
      </div>
      <MetricsChart title="CPU usage" unit="cpu" :labels="cpuLabels" :data="cpuData" />
      <MetricsChart title="Memory usage" unit="memory" :labels="memLabels" :data="memData" />
    </template>
  </div>
</template>
