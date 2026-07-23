<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, triggerRef, watch } from "vue"

import { fetchNodeMetrics } from "@/api/ui"
import type { K8sObject, MetricsResponse } from "@/api/types"
import MetricsChart from "@/components/metrics/MetricsChart.vue"
import MetricsUnavailable from "@/components/metrics/MetricsUnavailable.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import { useMetricsPolling } from "@/composables/useMetricsPolling"
import { useAuthStore } from "@/stores/auth"
import { usePreferencesStore } from "@/stores/preferences"
import { getMetricsBuffer } from "@/utils/metricsCache"
import { METRICS_RANGE_OPTIONS, METRICS_RANGE_SECONDS } from "@/utils/metricsRanges"

const props = defineProps<{ object: K8sObject }>()

const auth = useAuthStore()
const prefs = usePreferencesStore()
const range = ref(prefs.prefs.metrics.defaultRange)

// Node names collide across clusters, so the scope key is prefixed with the
// active context to keep each cluster's series separate.
const cpuKey = () => `${auth.activeContext}:node:${props.object.metadata?.name ?? ""}:cpu`
const memKey = () => `${auth.activeContext}:node:${props.object.metadata?.name ?? ""}:mem`
const cpuBuffer = shallowRef(getMetricsBuffer(cpuKey()))
const memBuffer = shallowRef(getMetricsBuffer(memKey()))

function onSample(resp: MetricsResponse): void {
  const item = resp.items[0]
  if (item === undefined) return
  const tsMs = Date.parse(resp.observedAt)
  if (Number.isNaN(tsMs)) return
  cpuBuffer.value.push(tsMs, { usage: item.cpuNanoCores })
  memBuffer.value.push(tsMs, { usage: item.memoryBytes })
  triggerRef(cpuBuffer)
  triggerRef(memBuffer)
}

const polling = useMetricsPolling({
  fetcher: () => fetchNodeMetrics(props.object.metadata?.name ?? ""),
  onSample,
})

onMounted(() => void polling.start())

// The detail page reuses this component across node navigations, so an in-place
// node change must rebind to that node's cached buffers and restart polling —
// otherwise the charts blend both nodes' series. Rebinding (vs. clearing) keeps
// each node's history alive in the shared cache.
watch(
  () => [props.object.metadata?.name, auth.activeContext],
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
        <span v-if="polling.error.value !== null" class="text-xs text-red-500">
          {{ polling.error.value }}
        </span>
      </div>
      <MetricsChart title="CPU usage" unit="cpu" :labels="cpuBuffer.labels()" :data="cpuData" />
      <MetricsChart title="Memory usage" unit="memory" :labels="memBuffer.labels()" :data="memData" />
    </template>
  </div>
</template>
