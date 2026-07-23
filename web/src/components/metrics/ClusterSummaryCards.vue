<script setup lang="ts">
import { computed, onMounted } from "vue"
import type { RouteLocationRaw } from "vue-router"

import { useClusterSummary } from "@/composables/useClusterSummary"
import { resourceListRoute } from "@/router"
import { formatBytes, formatCores } from "@/utils/units"

import GaugeCard from "./GaugeCard.vue"

const podsRoute = resourceListRoute({ group: "", version: "v1", resource: "pods" })
const nodesRoute = resourceListRoute({ group: "", version: "v1", resource: "nodes" })

// useClusterSummary follows the active cluster itself (context watch + auth
// gate live inside the composable).
const summary = useClusterSummary()
onMounted(summary.start)

function ratio(used: number | null, total: number): number | null {
  if (used === null || total <= 0) return null
  return (used / total) * 100
}

interface Gauge {
  key: string
  title: string
  detail: string
  percent: number | null
  variant: "usage" | "health"
  to?: RouteLocationRaw
}

const cards = computed<Gauge[]>(() => {
  const d = summary.data.value
  if (d === null) return []
  const cpuUsed = d.cpu.usedCores === null ? "—" : formatCores(d.cpu.usedCores)
  const memUsed = d.memory.usedBytes === null ? "—" : formatBytes(d.memory.usedBytes)
  return [
    {
      key: "cpu",
      title: "CPU Usage",
      detail: `${cpuUsed} / ${formatCores(d.cpu.totalCores)} cores`,
      percent: ratio(d.cpu.usedCores, d.cpu.totalCores),
      variant: "usage",
    },
    {
      key: "memory",
      title: "Memory Usage",
      detail: `${memUsed} / ${formatBytes(d.memory.totalBytes)}`,
      percent: ratio(d.memory.usedBytes, d.memory.totalBytes),
      variant: "usage",
    },
    {
      key: "pods",
      title: "Pods",
      detail: `${d.pods.count} / ${d.pods.capacity}`,
      percent: ratio(d.pods.count, d.pods.capacity),
      variant: "usage",
      to: podsRoute,
    },
    {
      key: "nodes",
      title: "Nodes",
      detail: `${d.nodes.ready} / ${d.nodes.total} Ready`,
      percent: ratio(d.nodes.ready, d.nodes.total),
      variant: "health",
      to: nodesRoute,
    },
  ]
})
</script>

<template>
  <!-- The heading lives inside the availability guard so a forbidden node list
       hides the whole block instead of leaving a dangling section title. -->
  <section v-if="summary.available.value && cards.length > 0" class="space-y-2">
    <div class="flex items-baseline gap-2">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Cluster
      </h2>
      <span class="text-xs text-slate-400">global view</span>
    </div>
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <GaugeCard
        v-for="card in cards"
        :key="card.key"
        :title="card.title"
        :detail="card.detail"
        :percent="card.percent"
        :variant="card.variant"
        :to="card.to"
      />
    </div>
  </section>
</template>
