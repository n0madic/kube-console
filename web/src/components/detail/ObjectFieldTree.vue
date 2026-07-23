<script setup lang="ts">
// Recursive renderer for the field tree built by utils/fieldTree. Renders
// itself for nested groups/items (Vue resolves the self-reference by
// filename). Big subtrees and deep levels start collapsed; toggles are
// remembered per node key while the component lives.

import { computed, ref } from "vue"
import type { RouteLocationRaw } from "vue-router"

import { useDiscovery } from "@/composables/useDiscovery"
import { resourceDetailRoute } from "@/router"
import type { FieldNode, GroupNode, ItemsNode, ObjectRef, TableCell } from "@/utils/fieldTree"
import { LONG_VALUE_CHARS } from "@/utils/fieldTree"

const props = withDefaults(
  defineProps<{
    nodes: FieldNode[]
    depth?: number
    /** Namespace of the object being rendered: where a reference that carries
     * no namespace of its own (roleRef, scaleTargetRef, …) points. */
    namespace?: string
  }>(),
  { depth: 0, namespace: undefined },
)

const discovery = useDiscovery()

/**
 * Detail route for a referenced object, or null when the kind is not
 * discoverable (RBAC-less clusters, removed CRDs) or a namespaced target has
 * no namespace to point at — a link there would only 404.
 */
function resolveRefRoute(ref: ObjectRef): RouteLocationRaw | null {
  // A ref may name an apiVersion that no longer exists (extensions/v1beta1);
  // fall back to resolving the kind alone rather than dropping the link.
  const entry =
    (ref.apiVersion !== undefined ? discovery.findByKind(ref.apiVersion, ref.kind) : undefined) ??
    discovery.findByLowerKind(ref.kind, ref.apiGroup)
  if (entry === undefined) return null
  if (!entry.namespaced) return resourceDetailRoute(entry, undefined, ref.name)
  const namespace = ref.namespace ?? props.namespace
  if (namespace === undefined || namespace === "") return null
  return resourceDetailRoute(entry, namespace, ref.name)
}

// Resolved once per nodes/discovery change instead of per render: the template
// asks for every referencing leaf on every render, twice (once to decide whether
// to link, once for the target), and each ask walks the whole discovery catalog.
// A computed keyed by ObjectRef identity needs no manual invalidation — the
// lookups inside resolveRefRoute read the discovery query, so a cluster switch
// or a late-resolving catalog rebuilds the map on its own.
const refRoutes = computed(() => {
  const resolved = new Map<ObjectRef, RouteLocationRaw | null>()
  for (const node of props.nodes) {
    if (node.type === "leaf" && node.ref !== undefined) {
      resolved.set(node.ref, resolveRefRoute(node.ref))
    }
  }
  return resolved
})

function refRoute(ref: ObjectRef | undefined): RouteLocationRaw | null {
  if (ref === undefined) return null
  return refRoutes.value.get(ref) ?? null
}

// Subtrees larger than this (or nested deeper than 2 levels) start collapsed.
const MAX_OPEN_SIZE = 25
const MAX_OPEN_ITEMS = 3
// Table cells are horizontally cramped; preview less than the leaf's 140.
const CELL_PREVIEW_CHARS = 60

const toggled = ref<Record<string, boolean>>({})
const expandedLong = ref<Set<string>>(new Set())

function defaultGroupOpen(node: GroupNode): boolean {
  return props.depth < 2 && node.leafCount <= MAX_OPEN_SIZE
}

function defaultItemOpen(node: ItemsNode, leafCount: number): boolean {
  return props.depth < 2 && node.items.length <= MAX_OPEN_ITEMS && leafCount <= MAX_OPEN_SIZE
}

function isOpen(key: string, fallback: boolean): boolean {
  return toggled.value[key] ?? fallback
}

function toggle(key: string, fallback: boolean): void {
  toggled.value[key] = !isOpen(key, fallback)
}

function toggleLong(key: string): void {
  const next = new Set(expandedLong.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedLong.value = next
}

// Key flat-table rows/cells by their content, not their positional index, so a
// remembered expand toggle stays with its value if the array reorders.
function rowId(row: TableCell[]): string {
  return row.map((c) => c.text).join("\u001f")
}

function cellKey(nodeKey: string, row: TableCell[], ci: number): string {
  return `${nodeKey}:${rowId(row)}:${ci}`
}
</script>

<template>
  <dl class="grid grid-cols-[fit-content(16rem)_1fr] gap-x-4 gap-y-1 text-sm">
    <template v-for="node in nodes" :key="node.key">
      <!-- Scalar leaf -->
      <template v-if="node.type === 'leaf'">
        <dt class="text-slate-500 dark:text-slate-400">{{ node.label }}</dt>
        <dd class="min-w-0">
          <template v-if="!node.long">
            <!-- The name of a referenced object (involvedObject, roleRef, …)
                 links to it; anything else is plain text. -->
            <RouterLink
              v-if="refRoute(node.ref) !== null"
              :to="refRoute(node.ref)!"
              class="break-all font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
            >{{ node.text }}</RouterLink>
            <span
              v-else
              class="break-all font-mono text-xs"
              :class="node.statusClass ?? 'text-slate-700 dark:text-slate-300'"
            >{{ node.text }}</span>
            <span v-if="node.suffix !== ''" class="ml-1.5 text-xs text-slate-400">{{ node.suffix }}</span>
          </template>
          <template v-else>
            <pre
              v-if="expandedLong.has(node.key)"
              class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 font-mono text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300"
            >{{ node.text }}</pre>
            <span
              v-else
              class="break-all font-mono text-xs text-slate-700 dark:text-slate-300"
            >{{ node.text.slice(0, LONG_VALUE_CHARS) }}…</span>
            <button
              type="button"
              class="ml-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
              @click="toggleLong(node.key)"
            >
              {{ expandedLong.has(node.key) ? "collapse" : `expand (${node.text.length} chars)` }}
            </button>
          </template>
        </dd>
      </template>

      <!-- Array of scalars / label-like map -->
      <template v-else-if="node.type === 'chips'">
        <dt class="text-slate-500 dark:text-slate-400">{{ node.label }}</dt>
        <dd class="flex min-w-0 flex-wrap gap-1">
          <span
            v-for="(chip, i) in node.chips"
            :key="`${i}:${chip.text}`"
            class="break-all rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            <template v-if="!chip.long">{{ chip.text }}</template>
            <template v-else>
              <template v-if="expandedLong.has(`${node.key}:${i}`)">{{ chip.text }}</template>
              <template v-else>{{ chip.text.slice(0, LONG_VALUE_CHARS) }}…</template>
              <button
                type="button"
                class="ml-1 font-sans text-blue-600 hover:underline dark:text-blue-400"
                @click="toggleLong(`${node.key}:${i}`)"
              >{{ expandedLong.has(`${node.key}:${i}`) ? "collapse" : `expand (${chip.text.length})` }}</button>
            </template>
          </span>
        </dd>
      </template>

      <!-- Flat homogeneous array -->
      <div v-else-if="node.type === 'table'" class="col-span-2 min-w-0">
        <div class="mb-0.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {{ node.label }}
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="border-b border-slate-200 text-left uppercase text-slate-400 dark:border-slate-700">
                <th v-for="col in node.columns" :key="col" class="py-1 pr-3 font-semibold">
                  {{ col }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, ri) in node.rows"
                :key="`${ri}:${rowId(row)}`"
                class="border-b border-slate-100 dark:border-slate-800"
              >
                <td
                  v-for="(cell, ci) in row"
                  :key="ci"
                  class="break-all py-1 pr-3 font-mono"
                  :class="cell.statusClass ?? 'text-slate-700 dark:text-slate-300'"
                >
                  <template v-if="!cell.long">{{ cell.text }}</template>
                  <template v-else>
                    <pre
                      v-if="expandedLong.has(cellKey(node.key, row, ci))"
                      class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 dark:bg-slate-800"
                    >{{ cell.text }}</pre>
                    <span v-else>{{ cell.text.slice(0, CELL_PREVIEW_CHARS) }}…</span>
                    <button
                      type="button"
                      class="ml-1 font-sans text-blue-600 hover:underline dark:text-blue-400"
                      @click="toggleLong(cellKey(node.key, row, ci))"
                    >
                      {{ expandedLong.has(cellKey(node.key, row, ci)) ? "collapse" : `expand (${cell.text.length})` }}
                    </button>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Nested object -->
      <div v-else-if="node.type === 'group'" class="col-span-2 min-w-0">
        <button
          type="button"
          class="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          @click="toggle(node.key, defaultGroupOpen(node))"
        >
          <span class="inline-block w-3 text-center">{{ isOpen(node.key, defaultGroupOpen(node)) ? "▾" : "▸" }}</span>
          {{ node.label }}
          <span class="font-normal normal-case tracking-normal">({{ node.leafCount }})</span>
        </button>
        <div
          v-if="isOpen(node.key, defaultGroupOpen(node))"
          class="ml-1.5 mt-1 border-l border-slate-200 pl-3 dark:border-slate-800"
        >
          <ObjectFieldTree :nodes="node.children" :depth="depth + 1" :namespace="namespace" />
        </div>
      </div>

      <!-- Array of nested objects -->
      <div v-else class="col-span-2 min-w-0">
        <div class="mb-0.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {{ node.label }} <span class="font-normal">({{ node.items.length }})</span>
        </div>
        <div class="space-y-1">
          <div v-for="(item, ii) in node.items" :key="`${node.key}:${ii}:${item.title}`">
            <button
              type="button"
              class="flex items-center gap-1 font-mono text-xs text-slate-600 hover:text-slate-800 dark:text-slate-300 dark:hover:text-slate-100"
              @click="toggle(`${node.key}:${ii}`, defaultItemOpen(node, item.leafCount))"
            >
              <span class="inline-block w-3 text-center">
                {{ isOpen(`${node.key}:${ii}`, defaultItemOpen(node, item.leafCount)) ? "▾" : "▸" }}
              </span>
              {{ item.title }}
            </button>
            <div
              v-if="isOpen(`${node.key}:${ii}`, defaultItemOpen(node, item.leafCount))"
              class="ml-1.5 mt-1 border-l border-slate-200 pl-3 dark:border-slate-800"
            >
              <ObjectFieldTree :nodes="item.children" :depth="depth + 1" :namespace="namespace" />
            </div>
          </div>
        </div>
      </div>
    </template>
  </dl>
</template>
