<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import {
  isNavigationFailure,
  NavigationFailureType,
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
  type RouteLocationRaw,
} from "vue-router"

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
import { listQuery, parseListQuery, sameQuery, type ListQueryState } from "@/utils/listQuery"
import {
  shouldShowNamespaceColumn,
  withNamespaceCells,
  withNamespaceColumn,
} from "@/utils/namespaceColumn"

const props = defineProps<{ group: string; version: string; resource: string }>()

const router = useRouter()
const route = useRoute()
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
/** The label-selector field: a draft, applied only on Enter/Refresh. */
const labelSelector = ref("")
/** The selector the list is loaded with — what every listing (namespace
 * switch, relist, next page, name search) and the URL use, never the draft. */
const appliedSelector = ref("")
const createOpen = ref(false)

const listKey = computed(() => `${props.group}/${props.version}/${props.resource}`)

// A filter that arrives by URL may have been a name search (Enter) over a
// collection past the load cap, and the URL cannot say so: on a capped listing
// it is therefore run as one — banner included — rather than silently
// filtering only the loaded window.
let searchAfterLoad = false

function runPendingSearch(): void {
  if (!searchAfterLoad || list.loading.value) return
  searchAfterLoad = false
  if (filter.value.trim() !== "" && list.hasNextPage.value) void list.searchAllByName(filter.value)
}

// URL → view, at setup and on every navigation that lands a query the view
// does not already hold (another resource, Back/Forward, a link to the same
// list). The page's own replaces land a query equal to the view and are
// skipped, so a write cannot roll typing back. A namespace the URL does not
// name keeps the selected one: the selection is global and sidebar links carry
// no query, while the filters belong to this view and start empty.
function adoptQuery(state: ListQueryState): void {
  filter.value = state.filter
  labelSelector.value = state.labelSelector
  appliedSelector.value = state.labelSelector
  if (state.namespace !== "") ui.namespace = state.namespace
  searchAfterLoad = state.filter !== ""
}
adoptQuery(parseListQuery(route.query))

const list = useResourceList(
  () => apiRef.value,
  () => ({
    namespace: namespaced.value && ui.namespace !== "" ? ui.namespace : undefined,
    labelSelector: appliedSelector.value,
    pageSize: prefsStore.prefs.tablePageSize,
  }),
)

async function reload(): Promise<void> {
  await list.refresh()
  runPendingSearch()
}

/** Enter in the selector field and the Refresh button: apply the draft. */
function applySelector(): void {
  // A changed selector reloads through the watch below; an unchanged one is a
  // plain refresh.
  if (labelSelector.value !== appliedSelector.value) appliedSelector.value = labelSelector.value
  else void reload()
}

onMounted(() => {
  void reload()
})

// Both adopting watches are declared ahead of the reload watch, so a
// navigation lists once with everything it brought (the reload job is already
// queued when they write). The first resets the selector draft on a resource
// change even when the two URLs happen to be equal.
watch(
  () => [props.group, props.version, props.resource],
  () => adoptQuery(parseListQuery(route.query)),
)
watch(
  () => route.query,
  (query) => {
    if (route.name !== "resource-list" || sameQuery(urlQuery.value, query)) return
    adoptQuery(parseListQuery(query))
    // After the flush: if the adoption reloads, the list is loading by then
    // and the reload runs the search when it finishes.
    void nextTick(runPendingSearch)
  },
)
// A namespace switch keeps the filters, like `kubectl -l … -n …`.
watch(
  () => [
    props.group,
    props.version,
    props.resource,
    ui.namespace,
    namespaced.value,
    appliedSelector.value,
  ],
  () => void reload(),
)

// View → URL, as a replace: Back, a reload, a copied link and the detail
// page's way back (`rememberListQuery`) all reproduce the view, and typing
// does not stack history entries. Defaults are omitted, so an unfiltered list
// keeps a bare URL.
const urlQuery = computed(() =>
  listQuery({
    namespace: namespaced.value ? ui.namespace : "",
    filter: filter.value,
    labelSelector: appliedSelector.value,
  }),
)
watch(
  () => [listKey.value, urlQuery.value] as const,
  ([key, query]) => ui.rememberListQuery(key, query),
  { immediate: true },
)

// Filter keystrokes are debounced: every replace is a full navigation (guards,
// RouterView render, every route-dependent computed), and browsers throttle
// `history.replaceState` (WebKit throws past ~100 calls in a short window).
const FILTER_URL_DELAY_MS = 300
let urlTimer: ReturnType<typeof setTimeout> | undefined
// Set from the moment a navigation away starts: a replace issued while it is
// pending would become the newer navigation and cancel it — the click lost.
let leaving = false

function cancelUrlWrite(): void {
  if (urlTimer === undefined) return
  clearTimeout(urlTimer)
  urlTimer = undefined
}

function writeUrl(): void {
  cancelUrlWrite()
  if (leaving || route.name !== "resource-list" || sameQuery(urlQuery.value, route.query)) return
  void router.replace({ query: urlQuery.value })
}

watch(
  urlQuery,
  (query, prev) => {
    const filterOnly =
      prev !== undefined && query.namespace === prev.namespace && query.selector === prev.selector
    if (!filterOnly) {
      writeUrl()
      return
    }
    cancelUrlWrite()
    urlTimer = setTimeout(writeUrl, FILTER_URL_DELAY_MS)
  },
  { immediate: true },
)

/** A debounced write still pending when a navigation starts goes to the
 * current history entry directly: a `router.replace` here would cancel the
 * navigation, and dropping it would leave Back one keystroke behind. */
function flushUrlWrite(): void {
  if (urlTimer === undefined) return
  cancelUrlWrite()
  if (route.name !== "resource-list" || sameQuery(urlQuery.value, route.query)) return
  router.options.history.replace(router.resolve({ query: urlQuery.value }).fullPath)
}

onBeforeRouteLeave(() => {
  flushUrlWrite()
  leaving = true
})
onBeforeRouteUpdate(() => {
  flushUrlWrite()
  // Whatever superseded a pending leave keeps this page.
  leaving = false
})
// An aborted leave keeps the page too. A cancelled one does not reset the flag:
// the navigation that cancelled it either leaves as well or is an update above.
const removeAfterEach = router.afterEach((_to, _from, failure) => {
  if (isNavigationFailure(failure, NavigationFailureType.aborted)) leaving = false
})
onBeforeUnmount(() => {
  cancelUrlWrite()
  removeAfterEach()
})

function openDetail(row: K8sTableRow): void {
  const meta = row.object?.metadata
  // The row handed back by the table is the *projected* one in all-namespaces
  // mode, whose cell 0 is the injected Namespace — so the Name fallback has to
  // skip it, or a row without object metadata navigates to a namespace-as-name
  // and a guaranteed 404.
  const nameCell = row.cells[showNamespaceColumn.value ? 1 : 0]
  const name = meta?.name ?? String(nameCell ?? "")
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
// Re-runs per watch event (each one replaces list.rows), so the projection
// memoizes per source row and only the changed rows are rebuilt; the array
// itself is always new, which is what the table rebuilds its row model on.
const displayRows = computed(() =>
  showNamespaceColumn.value ? withNamespaceCells(list.rows.value) : list.rows.value,
)

// Default sort: events newest first ("Last Seen" holds relative ages, so
// ascending age = newest on top); pods newest first the same way (ascending
// "Age"); everything else by Name — this also keeps rows inserted by watch
// events in order. Columns missing the requested name are handled gracefully
// by the table (no sort applied).
const defaultSort = computed(() => {
  if (props.resource === "events") return { column: "Last Seen" }
  if (props.resource === "pods") return { column: "Age" }
  return { column: "Name" }
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
      @refresh="applySelector()"
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
      :default-sort="defaultSort"
      :reset-key="`${props.group}/${props.version}/${props.resource}`"
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
