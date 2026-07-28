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

  // The selector the rows on screen were actually listed with. The watch must
  // reconnect against *that*, not against whatever the toolbar holds right now:
  // the label selector is bound with a plain v-model and only applied on Enter,
  // so between a keystroke and Enter the live option and `resourceVersion`
  // describe different collections. useWatch calls buildUrl() again on every
  // reconnect (the apiserver closes watches routinely), which would resume the
  // unfiltered collection's resourceVersion under a half-typed selector: every
  // row outside it silently stops updating and its DELETED events never arrive,
  // with watchDegraded still false. Namespace rides along for the same reason,
  // even though a namespace change already forces a refresh.
  let loadedNamespace: string | undefined
  let loadedLabelSelector: string | undefined

  function rowKey(row: K8sTableRow): string {
    const meta = row.object?.metadata
    if (meta?.uid !== undefined) return meta.uid
    if (meta?.name !== undefined) return `${meta.namespace ?? ""}/${meta.name}`
    return String(row.cells[0] ?? "")
  }

  // rowKey → position in rows.value, kept ACROSS watch events. It used to be
  // rebuilt per event, so absorbing the single row an event usually carries ran
  // rowKey() over the whole collection — 5000 calls at the documented cap, and a
  // rollout emits dozens of events per second.
  //
  // setRows() is the choke point for every wholesale assignment of the
  // collection: it is what keeps the map in step with the array, and what stops
  // it surviving a resource-type / namespace / context switch (all of which
  // reload through load(), which resets the rows).
  let indexByKey = new Map<string, number>()

  function setRows(next: K8sTableRow[]): void {
    rows.value = next
    indexByKey = new Map()
    next.forEach((r, i) => indexByKey.set(rowKey(r), i))
  }

  function upsertRows(incoming: K8sTableRow[], removed: boolean): void {
    if (incoming.length === 0) return
    if (removed) {
      // A removal shifts every surviving position, so the index is rebuilt
      // wholesale here — the same O(n) the filter itself costs. Deletes are rare
      // next to MODIFIED (a rollout is a stream of modifications), so paying for
      // them keeps the hot path free of index bookkeeping.
      const removedKeys = new Set(incoming.map(rowKey))
      setRows(rows.value.filter((r) => !removedKeys.has(rowKey(r))))
      return
    }
    // The one assignment that deliberately does not go through setRows(): an
    // upsert leaves every existing position untouched, so the index is updated
    // incrementally (O(incoming)) instead of rebuilt — that is the whole point
    // of keeping it.
    //
    // The array identity must still change on every update. ResourceTable
    // memoizes its cell views per TanStack Row and TanStack rebuilds those
    // exactly when `data` changes identity (its column-def memo keys its own
    // invalidation on that contract), so mutating in place would leave stale
    // cells on screen. The copy is a pointer memcpy — what cost here was the
    // per-row rowKey() calls, not the copy. Do not "optimize" it away.
    const next = [...rows.value]
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
      return watchUrl(ref_, {
        namespace: loadedNamespace,
        resourceVersion: resourceVersion.value,
        labelSelector: loadedLabelSelector,
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
    // Pin what this collection is being listed with, so the watch reconnects
    // against the same selection the rows came from.
    loadedNamespace = opts.namespace
    loadedLabelSelector = opts.labelSelector
    loading.value = true
    error.value = null
    // Drop the previous resource type's rows/columns immediately: otherwise
    // they stay on screen — indistinguishable from freshly loaded data —
    // for the whole walk, e.g. while switching between resource tables.
    setRows([])
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
      setRows(walked.rows)
      resourceVersion.value = walked.resourceVersion
      continueToken.value = walked.continueToken
    } catch (e) {
      if (gen !== loadGen) return gen
      error.value = asApiError(e)
      setRows([])
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
    // Every path that stops the stream must say so. The toolbar's badge is the
    // only thing on screen distinguishing a live table from a static one, and
    // refresh() is the only way back: without this the rows sat there looking
    // live while no ADDED/MODIFIED/DELETED event could ever reach them.
    watchDegraded.value = true
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
    watchDegraded.value = true // ... and the toolbar has to say so (see nextPage)
    watcher.stop()
    loading.value = true
    error.value = null
    searchQuery.value = query.trim()
    searchTruncated.value = false
    searchScanned.value = 0
    setRows([])
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
      setRows(walked.rows)
      continueToken.value = ""
      resourceVersion.value = ""
    } catch (e) {
      if (gen !== loadGen) return
      error.value = asApiError(e)
      setRows([])
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
      // Stop first, like the sibling context watches (useClusterSummary,
      // ProblemPodsCard): the running watch streams the *previous* cluster's
      // events, and refresh() is what would otherwise have stopped it. Without
      // this, a switch to a context with no session leaves that stream upserting
      // old-cluster rows into a list the UI now labels as the new one.
      watcher.stop()
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
