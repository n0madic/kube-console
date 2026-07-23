<script setup lang="ts">
import { computed } from "vue"

import type { K8sObject } from "@/api/types"
import ExpandableValue from "@/components/ui/ExpandableValue.vue"
import { formatBytes } from "@/utils/units"

const props = defineProps<{ object: K8sObject }>()

const entries = computed(() => Object.entries(props.object.data ?? {}))
const binaryEntries = computed(() =>
  Object.entries(((props.object.binaryData as Record<string, string> | undefined) ?? {})),
)

function base64Size(b64: string): number {
  // Each 4 base64 chars encode 3 bytes; trailing '=' padding shrinks the last
  // group, so subtract it or small values overstate their decoded size.
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - padding
}
</script>

<template>
  <section class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
    <h3 class="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Data</h3>
    <p v-if="entries.length === 0 && binaryEntries.length === 0" class="text-sm text-slate-400">
      No data keys.
    </p>
    <ul class="space-y-2">
      <li
        v-for="[key, value] in entries"
        :key="key"
        class="rounded-md border border-slate-100 p-2 dark:border-slate-800"
      >
        <span class="font-mono text-sm font-medium">{{ key }}</span>
        <ExpandableValue :value="value" class="mt-2" />
      </li>
      <li
        v-for="[key, value] in binaryEntries"
        :key="`bin-${key}`"
        class="rounded-md border border-slate-100 p-2 dark:border-slate-800"
      >
        <span class="font-mono text-sm font-medium">{{ key }}</span>
        <span class="ml-2 text-xs text-slate-400">(binary, {{ formatBytes(base64Size(value)) }})</span>
      </li>
    </ul>
  </section>
</template>
