// Resource list state: Kubernetes Table + continue-token pagination + live
// watch (first page only). Falls back to plain List conversion when the
// server does not support Table.

import { computed, ref, shallowRef, watch } from "vue"

import { ApiError, asApiError } from "@/api/http"
import { TABLE_ACCEPT, walkTable, watchUrl } from "@/api/k8s"
import type {
  K8sObject,
  K8sTable,
  K8sTableColumn,
  K8sTableRow,
  ResourceRef,
  WatchEvent,
} from "@/api/types"
import { useAuthStore } from "@/stores/auth"
import { listToTable } from "@/utils/tableFallback"

import { useWatch } from "./useWatch"

export interface ResourceListOptions {
  namespace?: string
  labelSelector?: string
  pageSize: number
}

export function useResourceList(
  getRef: () => ResourceRef | null,
  getOptions: () => ResourceListOptions,
) {
  const auth = useAuthStore()
  const columns = ref<K8sTableColumn[]>([])
  const rows = shallowRef<K8sTableRow[]>([])
  const loading = ref(false)
  const error = ref<ApiError | null>(null)
  const fallback = ref(false)
  const continueToken = ref("")
  const resourceVersion = ref("")
  /** True after "next page": watch is disabled until restart. */
  const paged = ref(false)
  const watchDegraded = ref(false)

  // Generation guard shared by load()/searchAllByName(): overlapping loads
  // (namespace switch or navigation mid-walk) must not let a slower stale
  // response overwrite the newer collection.
  let loadGen = 0

  function rowKey(row: K8sTableRow): string {
    const meta = row.object?.metadata
    if (meta?.uid !== undefined) return meta.uid
    if (meta?.name !== undefined) return `${meta.namespace ?? ""}/${meta.name}`
    return String(row.cells[0] ?? "")
  }

  function upsertRows(incoming: K8sTableRow[], removed: boolean): void {
    if (incoming.length === 0) return
    // O(n+m): key the current set once instead of a linear findIndex per
    // incoming row (which recomputed rowKey for every existing row).
    if (removed) {
      const removedKeys = new Set(incoming.map(rowKey))
      rows.value = rows.value.filter((r) => !removedKeys.has(rowKey(r)))
      return
    }
    const next = [...rows.value]
    const indexByKey = new Map<string, number>()
    next.forEach((r, i) => indexByKey.set(rowKey(r), i))
    for (const row of incoming) {
      const key = rowKey(row)
      const idx = indexByKey.get(key)
      if (idx !== undefined) {
        next[idx] = row
      } else {
        indexByKey.set(key, next.length)
        next.push(row)
      }
    }
    rows.value = next
  }

  function handleEvent(event: WatchEvent): void {
    const obj = event.object as K8sObject & Partial<K8sTable>
    if (event.type === "BOOKMARK") {
      const rv = obj.metadata?.resourceVersion
      if (rv !== undefined && rv !== "") resourceVersion.value = rv
      return
    }
    let eventRows: K8sTableRow[]
    if (obj.kind === "Table") {
      eventRows = (obj as K8sTable).rows ?? []
    } else {
      eventRows = listToTable({ items: [obj] }).rows ?? []
    }
    const rv = obj.metadata?.resourceVersion
    if (rv !== undefined && rv !== "") resourceVersion.value = rv
    upsertRows(eventRows, event.type === "DELETED")
  }

  const watcher = useWatch({
    buildUrl: () => {
      const ref_ = getRef()
      // No live watch while paged or capped (continue token outstanding): the
      // in-memory set is only the first window of a larger collection.
      if (
        ref_ === null ||
        paged.value ||
        continueToken.value !== "" ||
        resourceVersion.value === ""
      ) {
        return null
      }
      const opts = getOptions()
      return watchUrl(ref_, {
        namespace: opts.namespace,
        resourceVersion: resourceVersion.value,
        labelSelector: opts.labelSelector,
      })
    },
    headers: { Accept: TABLE_ACCEPT },
    onEvent: handleEvent,
    onStale: () => {
      // 410 Gone: relist from scratch, then the watch restarts itself.
      void refresh()
    },
  })

  // The whole collection is loaded in chunks (kubectl --sort-by does the
  // same) so client-side sorting covers every object, not just one page.
  // Beyond the cap the continue token remains for forward pagination.
  const LIST_CHUNK_SIZE = 500
  const MAX_LIST_PAGES = 10 // cap: up to 5000 objects per view

  async function load(continueFrom: string): Promise<number> {
    const gen = ++loadGen
    const ref_ = getRef()
    if (ref_ === null) return gen
    const opts = getOptions()
    loading.value = true
    error.value = null
    // Drop the previous resource type's rows/columns immediately: otherwise
    // they stay on screen — indistinguishable from freshly loaded data —
    // for the whole walk, e.g. while switching between resource tables.
    rows.value = []
    columns.value = []
    try {
      const walked = await walkTable(ref_, {
        namespace: opts.namespace,
        labelSelector: opts.labelSelector,
        limit: Math.max(LIST_CHUNK_SIZE, opts.pageSize),
        continueToken: continueFrom,
        maxPages: MAX_LIST_PAGES,
        shouldAbort: () => gen !== loadGen,
      })
      if (gen !== loadGen) return gen // superseded: drop stale work
      columns.value = walked.columnDefinitions
      fallback.value = walked.fallback
      rows.value = walked.rows
      resourceVersion.value = walked.resourceVersion
      continueToken.value = walked.continueToken
    } catch (e) {
      if (gen !== loadGen) return gen
      error.value = asApiError(e)
      rows.value = []
      columns.value = []
    } finally {
      if (gen === loadGen) loading.value = false
    }
    return gen
  }

  /** Load the first page and (re)start the watch. */
  async function refresh(): Promise<void> {
    paged.value = false
    searchQuery.value = null
    searchTruncated.value = false
    watcher.stop()
    const gen = await load("")
    if (gen !== loadGen) return // a newer load/refresh superseded this one
    // Only watch a complete, uncapped collection: a lingering continue token
    // means we hold just the first window, so live upserts would grow it past
    // the cap.
    if (error.value === null && resourceVersion.value !== "" && continueToken.value === "") {
      watchDegraded.value = false
      watcher.start()
    } else {
      watchDegraded.value = true
    }
  }

  /** Continue-token pagination: forward only; restart via refresh(). */
  async function nextPage(): Promise<void> {
    if (continueToken.value === "") return
    paged.value = true
    watcher.stop()
    await load(continueToken.value)
  }

  // Server-wide name search: the Kubernetes API has no substring selector,
  // so all pages are walked via continue tokens (bounded) and matched by
  // name client-side.
  const searchQuery = ref<string | null>(null)
  const searchTruncated = ref(false)
  const searchScanned = ref(0)

  const SEARCH_PAGE_SIZE = 500
  const MAX_SEARCH_PAGES = 20 // up to 10k objects scanned
  const MAX_SEARCH_MATCHES = 1000

  function rowName(row: K8sTableRow): string {
    return row.object?.metadata?.name ?? String(row.cells[0] ?? "")
  }

  /**
   * Search the whole collection by a name substring (case-insensitive).
   * No-op when the full collection is already in memory — the live filter
   * covers everything; the server walk only matters for truncated views.
   */
  async function searchAllByName(query: string): Promise<void> {
    const q = query.trim().toLowerCase()
    if (q === "") {
      await refresh()
      return
    }
    const viewComplete =
      resourceVersion.value !== "" && continueToken.value === "" && !paged.value
    if (viewComplete) return
    const ref_ = getRef()
    if (ref_ === null) return
    const opts = getOptions()
    const gen = ++loadGen
    paged.value = true // no watch while showing a synthetic result set
    watcher.stop()
    loading.value = true
    error.value = null
    searchQuery.value = query.trim()
    searchTruncated.value = false
    searchScanned.value = 0
    rows.value = []
    try {
      const walked = await walkTable(ref_, {
        namespace: opts.namespace,
        labelSelector: opts.labelSelector,
        limit: SEARCH_PAGE_SIZE,
        maxPages: MAX_SEARCH_PAGES,
        keepRow: (row) => rowName(row).toLowerCase().includes(q),
        maxRows: MAX_SEARCH_MATCHES,
        shouldAbort: () => gen !== loadGen,
      })
      if (gen !== loadGen) return // superseded (e.g. Clear / namespace switch)
      columns.value = walked.columnDefinitions
      fallback.value = walked.fallback
      searchTruncated.value = walked.truncated
      searchScanned.value = walked.scanned
      rows.value = walked.rows
      continueToken.value = ""
      resourceVersion.value = ""
    } catch (e) {
      if (gen !== loadGen) return
      error.value = asApiError(e)
      rows.value = []
    } finally {
      if (gen === loadGen) loading.value = false
    }
  }

  // Follow the active cluster: switching context rebuilds the list from the new
  // cluster's data (apiFetch stamps the new context header) and restarts the
  // watch, dropping any in-flight response from the previous cluster. This also
  // covers switching while already sitting on a list page. Skipped when the new
  // context has no session yet — the switcher routes to login and a tokenless
  // request would only 401 through the global handler.
  watch(
    () => auth.activeContext,
    () => {
      if (!auth.isAuthenticated) return
      void refresh()
    },
  )

  const hasNextPage = computed(() => continueToken.value !== "")

  return {
    columns,
    rows,
    loading,
    error,
    fallback,
    paged,
    hasNextPage,
    watchDegraded,
    searchQuery,
    searchTruncated,
    searchScanned,
    refresh,
    nextPage,
    searchAllByName,
    stopWatch: watcher.stop,
  }
}
