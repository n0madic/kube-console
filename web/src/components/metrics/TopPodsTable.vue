<script setup lang="ts">
import { computed } from "vue"

import type { MetricsItem } from "@/api/types"
import { resourceDetailRoute } from "@/router"
import { formatBytes, formatCpu } from "@/utils/units"

const props = defineProps<{
  title: string
  items: MetricsItem[]
  sortBy: "cpu" | "memory"
  limit?: number
}>()

const sorted = computed(() =>
  [...props.items]
    .sort((a, b) =>
      props.sortBy === "cpu" ? b.cpuNanoCores - a.cpuNanoCores : b.memoryBytes - a.memoryBytes,
    )
    .slice(0, props.limit ?? 10),
)

function podRoute(item: MetricsItem) {
  return resourceDetailRoute(
    { group: "", version: "v1", resource: "pods" },
    item.namespace,
    item.name,
  )
}
</script>

<template>
  <section class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
    <h3 class="mb-3 text-sm font-semibold">{{ title }}</h3>
    <p v-if="sorted.length === 0" class="text-sm text-slate-400">No pod metrics.</p>
    <table v-else class="w-full text-sm">
      <thead>
        <tr class="border-b border-slate-200 text-left text-xs uppercase text-slate-400 dark:border-slate-700">
          <th class="py-1.5 pr-3">Pod</th>
          <th class="py-1.5 pr-3">Namespace</th>
          <th class="py-1.5 text-right">{{ sortBy === "cpu" ? "CPU" : "Memory" }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="item in sorted"
          :key="`${item.namespace}/${item.name}`"
          class="border-b border-slate-100 dark:border-slate-800"
        >
          <td class="py-1.5 pr-3">
            <RouterLink :to="podRoute(item)" class="text-blue-600 hover:underline dark:text-blue-400">
              {{ item.name }}
            </RouterLink>
          </td>
          <td class="py-1.5 pr-3 text-slate-500 dark:text-slate-400">{{ item.namespace }}</td>
          <td class="py-1.5 text-right font-mono text-xs">
            {{ sortBy === "cpu" ? formatCpu(item.cpuNanoCores) : formatBytes(item.memoryBytes) }}
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
