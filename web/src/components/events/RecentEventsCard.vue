<script setup lang="ts">
// Latest cluster events for the overview page, scoped to the selected
// namespace ("" = all namespaces).

import { computed, onMounted, ref, watch } from "vue"
import type { RouteLocationRaw } from "vue-router"

import { apiJson, messageFromError } from "@/api/http"
import { resourcePath } from "@/api/k8s"
import type { K8sObjectList } from "@/api/types"
import BaseButton from "@/components/ui/BaseButton.vue"
import { useDiscovery } from "@/composables/useDiscovery"
import { resourceDetailRoute } from "@/router"
import { useAuthStore } from "@/stores/auth"
import { usePreferencesStore } from "@/stores/preferences"
import { useUiStore } from "@/stores/ui"
import {
  eventRowClass,
  sortByLastSeenDesc,
  toEventRow,
  type EventRow,
} from "@/utils/eventHelpers"
import { statusTextClass } from "@/utils/statusColors"
import { formatAge } from "@/utils/units"

const LIMIT = 20
// Events are not server-sortable; fetch a bounded batch and sort client-side.
const FETCH_LIMIT = 1000

const ui = useUiStore()
const auth = useAuthStore()
const discovery = useDiscovery()
const prefs = usePreferencesStore()

// Full sorted batch; the visible slice (and the warnings filter) derive from it
// so toggling "Only warnings" never needs a refetch.
const allRows = ref<EventRow[]>([])
const loading = ref(false)
const errorText = ref<string | null>(null)

// Guards against a stale in-flight response (previous namespace or cluster)
// overwriting a newer one on a rapid namespace/context switch.
let loadId = 0

async function load(): Promise<void> {
  const id = ++loadId
  loading.value = true
  errorText.value = null
  try {
    const base = resourcePath(
      { group: "", version: "v1", resource: "events" },
      { namespace: ui.namespace },
    )
    const list = await apiJson<K8sObjectList>(`${base}?limit=${FETCH_LIMIT}`, {
      headers: { Accept: "application/json" },
    })
    if (id !== loadId) return
    allRows.value = sortByLastSeenDesc((list.items ?? []).map(toEventRow))
  } catch (e) {
    if (id !== loadId) return
    errorText.value = messageFromError(e)
  } finally {
    if (id === loadId) loading.value = false
  }
}

onMounted(load)
watch(() => ui.namespace, load)

// Follow the active cluster: the Overview stays mounted across a context
// switch and the namespace often does not change, so the namespace watch alone
// would leave the previous cluster's events on screen. Drop them, invalidate
// any in-flight response from the old cluster, and refetch — unless the new
// context has no session, where a tokenless request would only 401.
watch(
  () => auth.activeContext,
  () => {
    loadId += 1
    allRows.value = []
    errorText.value = null
    if (!auth.isAuthenticated) {
      loading.value = false
      return
    }
    void load()
  },
)

function involvedRoute(row: EventRow): RouteLocationRaw | null {
  if (row.involvedKind === "" || row.involvedName === "") return null
  const entry = discovery.findByKind(row.involvedApiVersion, row.involvedKind)
  if (entry === undefined) return null
  return resourceDetailRoute(
    { group: entry.group, version: entry.version, resource: entry.resource },
    entry.namespaced ? row.namespace : undefined,
    row.involvedName,
  )
}

// Filter to warnings (when enabled) before capping, so the toggle surfaces up
// to LIMIT warnings rather than whatever warnings happen to be in the top slice.
const rows = computed(() => {
  const filtered = prefs.prefs.eventsOnlyWarnings
    ? allRows.value.filter((row) => row.type === "Warning")
    : allRows.value
  return filtered.slice(0, LIMIT)
})

// Resolve each row's involved-object route once per render instead of calling
// involvedRoute (which does a discovery lookup) three times per row in the
// template.
const rowsWithRoute = computed(() => rows.value.map((row) => ({ row, to: involvedRoute(row) })))
</script>

<template>
  <section class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
    <div class="mb-3 flex items-center justify-between gap-3">
      <h3 class="text-sm font-semibold">Recent events</h3>
      <div class="flex items-center gap-3">
        <label class="flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
          <input v-model="prefs.prefs.eventsOnlyWarnings" type="checkbox" /> Only warnings
        </label>
        <BaseButton :disabled="loading" @click="load">
          {{ loading ? "Loading..." : "Refresh" }}
        </BaseButton>
      </div>
    </div>

    <p v-if="errorText !== null" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      {{ errorText }}
    </p>
    <p v-else-if="!loading && rows.length === 0" class="py-6 text-center text-sm text-slate-400">
      {{ prefs.prefs.eventsOnlyWarnings ? "No recent warnings." : "No recent events." }}
    </p>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-left text-xs uppercase text-slate-400">
          <tr>
            <th class="px-2 py-1.5">Type</th>
            <th class="px-2 py-1.5">Reason</th>
            <th class="px-2 py-1.5">Object</th>
            <th class="px-2 py-1.5">Namespace</th>
            <th class="px-2 py-1.5">Age</th>
            <th class="px-2 py-1.5">Message</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="({ row, to }, idx) in rowsWithRoute"
            :key="row.uid || idx"
            class="border-t border-slate-100 dark:border-slate-800"
            :class="eventRowClass(row)"
          >
            <td
              class="px-2 py-1.5"
              :class="row.type === 'Warning' ? 'text-amber-600 dark:text-amber-400' : ''"
            >
              {{ row.type }}
            </td>
            <td class="px-2 py-1.5" :class="statusTextClass(row.reason) ?? ''">{{ row.reason }}</td>
            <td class="px-2 py-1.5">
              <RouterLink
                v-if="to !== null"
                :to="to"
                class="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                {{ row.involvedKind }}/{{ row.involvedName }}
              </RouterLink>
              <span v-else class="font-mono text-xs">{{ row.involvedKind }}/{{ row.involvedName }}</span>
            </td>
            <td class="px-2 py-1.5 text-slate-500 dark:text-slate-400">{{ row.namespace }}</td>
            <td class="whitespace-nowrap px-2 py-1.5">{{ formatAge(row.lastSeen) }}</td>
            <td class="break-words px-2 py-1.5 text-slate-600 dark:text-slate-300">{{ row.message }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
