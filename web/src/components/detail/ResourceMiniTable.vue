<script setup lang="ts">
// Compact, non-virtualized table for detail-page cards (pods on a node,
// related children). Purely presentational: it takes already-selected columns
// and rows (see utils/miniTable) and the ResourceRef to build name links.
// Status-bearing columns are colored with the same rule as the list page.

import { resourceDetailRoute } from "@/router"
import type { ResourceRef } from "@/api/types"
import type { MiniRow } from "@/utils/miniTable"
import { isStatusColumn, statusTextClass } from "@/utils/statusColors"

const props = defineProps<{
  linkRef: ResourceRef
  columns: string[]
  rows: MiniRow[]
  showNamespace?: boolean
}>()

function cellClass(columnName: string, value: string): string {
  return (
    (isStatusColumn(columnName) ? statusTextClass(value) : null) ??
    "text-slate-700 dark:text-slate-300"
  )
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead>
        <tr
          class="border-b border-slate-200 text-left text-xs uppercase text-slate-400 dark:border-slate-700"
        >
          <th v-if="props.showNamespace" class="py-1.5 pr-3">Namespace</th>
          <th class="py-1.5 pr-3">Name</th>
          <th v-for="col in columns" :key="col" class="py-1.5 pr-3">{{ col }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="`${row.namespace}/${row.name}`"
          class="border-b border-slate-100 dark:border-slate-800"
        >
          <td
            v-if="props.showNamespace"
            class="py-1.5 pr-3 font-mono text-xs text-slate-500 dark:text-slate-400"
          >
            {{ row.namespace }}
          </td>
          <td class="py-1.5 pr-3">
            <RouterLink
              :to="resourceDetailRoute(linkRef, row.namespace !== '' ? row.namespace : undefined, row.name)"
              class="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              {{ row.name }}
            </RouterLink>
          </td>
          <td
            v-for="(cell, i) in row.cells"
            :key="i"
            class="whitespace-nowrap py-1.5 pr-3 font-mono text-xs"
            :class="cellClass(columns[i] ?? '', cell)"
          >
            {{ cell }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
