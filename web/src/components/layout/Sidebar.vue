<script setup lang="ts">
import { computed, ref, watch } from "vue"

import type { DiscoveryResource } from "@/api/types"
import AppIcon from "@/components/ui/AppIcon.vue"
import { useDiscovery } from "@/composables/useDiscovery"
import { usePreferencesStore } from "@/stores/preferences"
import { useUiStore } from "@/stores/ui"
import { buildCatalog, matchesSearch } from "@/utils/resourceCatalog"

import ClusterName from "./ClusterName.vue"
import ClusterSelector from "./ClusterSelector.vue"
import SidebarLink from "./SidebarLink.vue"

const discovery = useDiscovery()
const prefs = usePreferencesStore()
const ui = useUiStore()

const catalog = computed(() => buildCatalog(discovery.resources.value))

const filteredCatalog = computed(() =>
  catalog.value
    .map((section) => ({
      name: section.name,
      resources: section.resources.filter((r) => matchesSearch(r, ui.sidebarSearch)),
    }))
    .filter((section) => section.resources.length > 0),
)

const pinned = computed<DiscoveryResource[]>(() => {
  const byId = new Map(discovery.resources.value.map((r) => [r.id, r]))
  return prefs.prefs.pinnedResources
    .map((id) => byId.get(id))
    .filter((r): r is DiscoveryResource => r !== undefined)
    .filter((r) => matchesSearch(r, ui.sidebarSearch))
})

function isPinned(id: string): boolean {
  return prefs.prefs.pinnedResources.includes(id)
}

// Collapsed catalog sections, by name. In-memory only: the collapse defaults
// are re-derived on every page load (see below) rather than persisted.
const collapsedSections = ref(new Set<string>())
let defaultsApplied = false

// Discovery arrives asynchronously, so the first non-empty catalog is what
// "page load" means here: with at least one pinned resource the pins are the
// entry point, so every section starts collapsed; without them the sidebar
// would be empty, so sections stay open.
watch(
  catalog,
  (sections) => {
    if (defaultsApplied || sections.length === 0) return
    defaultsApplied = true
    if (pinned.value.length > 0) {
      collapsedSections.value = new Set(sections.map((s) => s.name))
    }
  },
  { immediate: true },
)

function toggleSection(name: string): void {
  const next = new Set(collapsedSections.value)
  if (!next.delete(name)) next.add(name)
  collapsedSections.value = next
}

// A search must never hide its own matches, so collapsed state is ignored
// while the box has a query (and honored again once it is cleared).
function isCollapsed(name: string): boolean {
  return ui.sidebarSearch.trim() === "" && collapsedSections.value.has(name)
}

// Drag & drop reordering of the pinned list (HTML5 DnD, no library).
const draggingId = ref<string | null>(null)
const dropTargetId = ref<string | null>(null)

const canReorder = computed(() => pinned.value.length > 1)

function onDragStart(id: string, e: DragEvent): void {
  draggingId.value = id
  dropTargetId.value = null
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move"
    // Firefox only starts a drag once some data is attached.
    e.dataTransfer.setData("text/plain", id)
  }
}

function onDragOver(id: string, e: DragEvent): void {
  if (draggingId.value === null) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
  dropTargetId.value = id
}

function onDragLeave(id: string): void {
  if (dropTargetId.value === id) dropTargetId.value = null
}

function onDrop(id: string): void {
  if (draggingId.value !== null) prefs.movePinned(draggingId.value, id)
  onDragEnd()
}

function onDragEnd(): void {
  draggingId.value = null
  dropTargetId.value = null
}

/**
 * Full class in one expression (never mix a static text/border color with a
 * conditional one). Space for the insertion line is always reserved via
 * transparent per-side borders so rows do not shift while dragging; only
 * per-side color utilities are swapped, so no two classes fight over the
 * same CSS property.
 */
function rowClass(id: string): string {
  const base = "border-y-2 border-t-transparent border-b-transparent"
  if (draggingId.value === id) return `${base} opacity-40`
  if (draggingId.value === null || dropTargetId.value !== id) return base
  const list = prefs.prefs.pinnedResources
  return list.indexOf(id) < list.indexOf(draggingId.value)
    ? "border-y-2 border-t-amber-400 border-b-transparent"
    : "border-y-2 border-t-transparent border-b-amber-400"
}
</script>

<template>
  <aside
    class="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
  >
    <div class="flex h-14 min-w-0 items-center border-b border-slate-200 px-4 dark:border-slate-700">
      <RouterLink
        to="/overview"
        class="flex min-w-0 items-center gap-2 text-lg font-semibold text-slate-800 dark:text-slate-100"
      >
        <img src="/favicon.svg" alt="" aria-hidden="true" class="h-6 w-6 shrink-0" />
        <span class="truncate">kube-console</span>
      </RouterLink>
    </div>

    <!-- What the operator called this deployment, then which context of it is
         active: the second is hidden with a single context, the first is not. -->
    <ClusterName />
    <ClusterSelector />

    <div class="p-3">
      <input
        v-model="ui.sidebarSearch"
        type="search"
        placeholder="Search resources..."
        class="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
      />
    </div>

    <nav class="flex-1 overflow-y-auto px-2 pb-4 text-sm">
      <RouterLink
        to="/overview"
        class="mb-2 flex items-center gap-2 rounded-md px-2 py-1.5 font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        active-class="bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-white"
      >
        <AppIcon name="grid" class="h-4 w-4 shrink-0" />
        Overview
      </RouterLink>

      <p v-if="discovery.isLoading.value" class="px-2 text-slate-400">Loading API resources...</p>
      <p v-else-if="discovery.isError.value" class="px-2 text-red-500">
        Discovery failed. Check connectivity and permissions.
      </p>

      <template v-else>
        <div v-if="pinned.length > 0" class="mb-2">
          <p class="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Pinned
          </p>
          <div
            v-for="res in pinned"
            :key="`pin-${res.id}`"
            :draggable="canReorder"
            :class="[rowClass(res.id), canReorder ? 'cursor-grab active:cursor-grabbing' : '']"
            :data-pin-id="res.id"
            @dragstart="onDragStart(res.id, $event)"
            @dragover="onDragOver(res.id, $event)"
            @dragleave="onDragLeave(res.id)"
            @drop.prevent="onDrop(res.id)"
            @dragend="onDragEnd"
          >
            <SidebarLink
              :res="res"
              :pinned="true"
              dim-star
              @toggle-pin="prefs.togglePinned(res.id)"
            />
          </div>
        </div>

        <div v-for="section in filteredCatalog" :key="section.name" class="mb-2">
          <button
            type="button"
            class="flex w-full items-center gap-1 rounded-md px-2 pb-1 pt-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            :aria-expanded="!isCollapsed(section.name)"
            @click="toggleSection(section.name)"
          >
            <AppIcon
              name="caret-down"
              class="h-3 w-3 shrink-0 transition-transform"
              :class="isCollapsed(section.name) ? '-rotate-90' : ''"
            />
            {{ section.name }}
            <span v-if="isCollapsed(section.name)" class="ml-auto font-normal normal-case">
              {{ section.resources.length }}
            </span>
          </button>
          <template v-if="!isCollapsed(section.name)">
            <SidebarLink
              v-for="res in section.resources"
              :key="res.id"
              :res="res"
              :pinned="isPinned(res.id)"
              @toggle-pin="prefs.togglePinned(res.id)"
            />
          </template>
        </div>
      </template>
    </nav>
  </aside>
</template>
