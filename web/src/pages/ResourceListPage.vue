<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { useRouter, type RouteLocationRaw } from "vue-router"

import type { K8sTableRow, ResourceRef } from "@/api/types"
import CreateResourceDialog from "@/components/detail/CreateResourceDialog.vue"
import PaginationBar from "@/components/table/PaginationBar.vue"
import ResourceTable from "@/components/table/ResourceTable.vue"
import TableToolbar from "@/components/table/TableToolbar.vue"
import { useDiscovery } from "@/composables/useDiscovery"
import { useResourceList } from "@/composables/useResourceList"
import { resourceDetailRoute } from "@/router"
import { usePreferencesStore } from "@/stores/preferences"
import { useUiStore } from "@/stores/ui"
import { parseEventObjectCell } from "@/utils/eventHelpers"
import {
  shouldShowNamespaceColumn,
  withNamespaceCells,
  withNamespaceColumn,
} from "@/utils/namespaceColumn"

const props = defineProps<{ group: string; version: string; resource: string }>()

const router = useRouter()
const ui = useUiStore()
const prefsStore = usePreferencesStore()
const discovery = useDiscovery()

const apiRef = computed<ResourceRef>(() => ({
  group: props.group === "core" ? "" : props.group,
  version: props.version,
  resource: props.resource,
}))

const discoveryEntry = computed(() =>
  discovery.findResource(props.group, props.version, props.resource),
)
// Until discovery loads, assume namespaced (safe default for the selector).
const namespaced = computed(() => discoveryEntry.value?.namespaced ?? true)

const filter = ref("")
const labelSelector = ref("")
const createOpen = ref(false)

const list = useResourceList(
  () => apiRef.value,
  () => ({
    namespace: namespaced.value && ui.namespace !== "" ? ui.namespace : undefined,
    labelSelector: labelSelector.value,
    pageSize: prefsStore.prefs.tablePageSize,
  }),
)

onMounted(() => {
  void list.refresh()
})

watch(
  () => [props.group, props.version, props.resource, ui.namespace, namespaced.value],
  () => {
    filter.value = ""
    // Reset the label selector too, so it does not silently carry over to an
    // unrelated resource on sidebar navigation.
    labelSelector.value = ""
    void list.refresh()
  },
)

function openDetail(row: K8sTableRow): void {
  const meta = row.object?.metadata
  const name = meta?.name ?? String(row.cells[0] ?? "")
  if (name === "") return
  const namespace = namespaced.value ? (meta?.namespace ?? ui.namespace) : undefined
  void router.push(resourceDetailRoute(apiRef.value, namespace, name))
}

// In all-namespaces mode the Table API omits the namespace, so identically
// named objects across namespaces become indistinguishable — inject a
// Namespace column (kubectl `get -A` does the same client-side).
const showNamespaceColumn = computed(() =>
  shouldShowNamespaceColumn(list.columns.value, ui.namespace === "", namespaced.value),
)
const displayColumns = computed(() =>
  showNamespaceColumn.value ? withNamespaceColumn(list.columns.value) : list.columns.value,
)
const displayRows = computed(() =>
  showNamespaceColumn.value ? withNamespaceCells(list.rows.value) : list.rows.value,
)

const hiddenColumns = computed(() => {
  const key = discoveryEntry.value?.id ?? ""
  return prefsStore.prefs.hiddenColumns[key] ?? []
})

// Default sort: events newest first ("Last Seen" holds relative ages, so
// ascending age = newest on top); pods newest first the same way (ascending
// "Age"); everything else by Name — this also keeps rows inserted by watch
// events in order. Columns missing the requested name are handled gracefully
// by the table (no sort applied).
const defaultSort = computed(() => {
  if (props.resource === "events") return { column: "Last Seen", desc: false }
  if (props.resource === "pods") return { column: "Age", desc: false }
  return { column: "Name", desc: false }
})

const title = computed(() => discoveryEntry.value?.kind ?? props.resource)

/** Detail route for an event's "<kind>/<name>" Object cell, if resolvable. */
function eventObjectRoute(value: string, namespace: string): RouteLocationRaw | null {
  const parsed = parseEventObjectCell(value)
  if (parsed === null) return null
  const entry = discovery.findByLowerKind(parsed.kind)
  if (entry === undefined) return null
  return resourceDetailRoute(
    { group: entry.group, version: entry.version, resource: entry.resource },
    // An event lives in its involved object's namespace; cluster-scoped kinds
    // (Node events land in "default") take the sentinel instead.
    entry.namespaced ? namespace : undefined,
    parsed.name,
  )
}

// Events point their Object column at the involved object. Memoized per
// namespace+cell: the table asks per visible cell on every render, and each
// miss walks discovery. Reading the catalog (and namespace) here rebuilds the
// memo when either changes, so a cluster switch cannot leave stale routes.
const eventObjectLink = computed(() => {
  if (props.resource !== "events" || discovery.resources.value.length === 0) return undefined
  const fallbackNamespace = ui.namespace
  const cache = new Map<string, RouteLocationRaw | null>()
  return (row: K8sTableRow, column: string, value: string): RouteLocationRaw | null => {
    if (column !== "Object") return null
    const namespace = row.object?.metadata?.namespace ?? fallbackNamespace
    const key = `${namespace}/${value}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const route = eventObjectRoute(value, namespace)
    cache.set(key, route)
    return route
  }
})
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center gap-3 px-4 pb-1 pt-4">
      <h1 class="text-xl font-semibold">{{ title }}</h1>
      <span class="text-sm text-slate-400">
        {{ props.group === "core" ? "" : `${props.group}/` }}{{ props.version }} · {{ props.resource }}
        <template v-if="namespaced">
          · {{ ui.namespace === "" ? "all namespaces" : ui.namespace }}
        </template>
        <template v-else> · cluster-scoped</template>
      </span>
      <span
        v-if="list.fallback.value"
        class="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500 dark:bg-slate-800"
      >
        basic columns (no Table support)
      </span>
    </div>

    <TableToolbar
      v-model:filter="filter"
      v-model:label-selector="labelSelector"
      :loading="list.loading.value"
      :watch-degraded="list.watchDegraded.value"
      :deep-search="list.hasNextPage.value || list.paged.value"
      @refresh="list.refresh()"
      @search="list.searchAllByName(filter)"
      @create="createOpen = true"
    />

    <div
      v-if="list.searchQuery.value !== null"
      class="flex items-center gap-3 border-b border-blue-200 bg-blue-50 px-4 py-1.5 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100"
    >
      <span>
        Name search “{{ list.searchQuery.value }}”: {{ list.rows.value.length }} matches
        (scanned {{ list.searchScanned.value }} objects<template v-if="list.searchTruncated.value">,
          scan limit reached — results may be incomplete</template>).
      </span>
      <button
        type="button"
        class="font-medium hover:underline"
        @click="filter = ''; list.refresh()"
      >
        Clear
      </button>
    </div>

    <p
      v-if="list.error.value !== null"
      class="m-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
    >
      {{ list.error.value.message }}
    </p>

    <ResourceTable
      v-else
      :columns="displayColumns"
      :rows="displayRows"
      :global-filter="filter"
      :hidden-columns="hiddenColumns"
      :default-sort="defaultSort"
      :loading="list.loading.value"
      :cell-link="eventObjectLink"
      @row-click="openDetail"
    />

    <PaginationBar
      :has-next-page="list.hasNextPage.value"
      :paged="list.paged.value"
      :loading="list.loading.value"
      :row-count="list.rows.value.length"
      @next="list.nextPage()"
      @restart="list.refresh()"
    />

    <CreateResourceDialog
      v-if="discoveryEntry !== undefined"
      v-model:open="createOpen"
      :resource="discoveryEntry"
      :namespace="ui.namespace"
      @created="list.refresh()"
    />
  </div>
</template>
