<script setup lang="ts">
import { computed } from "vue"

import type { K8sObject } from "@/api/types"
import { formatAge } from "@/utils/units"

interface Condition {
  type?: string
  status?: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}

const props = defineProps<{ object: K8sObject }>()

const conditions = computed<Condition[]>(() => {
  const status = props.object.status as { conditions?: Condition[] } | undefined
  return Array.isArray(status?.conditions) ? status.conditions : []
})

// Conditions whose "True" means unhealthy (Node pressure/availability signals,
// and common controller conditions). For these, green/neutral is inverted so a
// problem state never renders as healthy green.
const NEGATIVE_WHEN_TRUE = new Set([
  "DiskPressure",
  "MemoryPressure",
  "PIDPressure",
  "NetworkUnavailable",
  "Degraded",
  "Failed",
  "Unschedulable",
])

const GOOD = "text-green-600 dark:text-green-400"
const BAD = "text-red-600 dark:text-red-400"
const NEUTRAL = "text-slate-500 dark:text-slate-400"

function statusClass(cond: Condition): string {
  const negative = NEGATIVE_WHEN_TRUE.has(cond.type ?? "")
  if (cond.status === "True") return negative ? BAD : GOOD
  if (cond.status === "False") return negative ? GOOD : NEUTRAL
  return NEUTRAL // Unknown / other
}
</script>

<template>
  <section
    v-if="conditions.length > 0"
    class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
  >
    <h3 class="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Conditions</h3>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-slate-200 text-left text-xs uppercase text-slate-400 dark:border-slate-700">
            <th class="py-1.5 pr-3">Type</th>
            <th class="py-1.5 pr-3">Status</th>
            <th class="py-1.5 pr-3">Reason</th>
            <th class="py-1.5 pr-3">Age</th>
            <th class="py-1.5">Message</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(cond, i) in conditions"
            :key="i"
            class="border-b border-slate-100 dark:border-slate-800"
          >
            <td class="py-1.5 pr-3 font-medium">{{ cond.type }}</td>
            <td class="py-1.5 pr-3" :class="statusClass(cond)">
              {{ cond.status }}
            </td>
            <td class="py-1.5 pr-3">{{ cond.reason }}</td>
            <td class="py-1.5 pr-3 whitespace-nowrap">{{ formatAge(cond.lastTransitionTime) }}</td>
            <td class="break-words py-1.5 text-slate-600 dark:text-slate-300">{{ cond.message }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
