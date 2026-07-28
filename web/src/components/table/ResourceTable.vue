<script setup lang="ts">
import {
  FlexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useVueTable,
  type Cell,
  type ColumnDef,
  type ColumnSizingState,
  type Row,
  type SortingState,
} from "@tanstack/vue-table"
import { useVirtualizer } from "@tanstack/vue-virtual"
import { computed, ref, watch } from "vue"
import type { RouteLocationRaw } from "vue-router"

import type { K8sTableColumn, K8sTableRow } from "@/api/types"
import { estimateColumnWidths, SAMPLE_ROWS } from "@/utils/columnWidths"
import type { StatusColumnKind } from "@/utils/statusColors"
import { cellTextClass, NEUTRAL_TEXT_CLASS, statusColumnKind } from "@/utils/statusColors"
import { cellText } from "@/utils/tableCells"
import { compareTableValues } from "@/utils/tableSort"

const props = defineProps<{
  columns: K8sTableColumn[]
  rows: K8sTableRow[]
  globalFilter: string
  /**
   * Sort applied when the column set (resource type) changes. Ascending only:
   * every caller's default is ascending (the age columns hold relative ages, so
   * ascending age *is* newest first), and a `desc` flag that was never passed
   * true made descending look like a supported option that nothing produced.
   * Clicking a header still toggles direction as usual.
   */
  defaultSort?: { column: string }
  /**
   * Identity of what is being listed, and the only thing that may reset manual
   * column widths, the chosen sort and the empty-column memo.
   *
   * The column *names* cannot stand in for it, in either direction. They go
   * blank mid-reload — useResourceList clears columns before every walk so the
   * previous kind's rows cannot linger — so keying on them threw away the user's
   * sort and drag-resized widths on every Refresh, every label-selector apply and
   * every 410 relist, the last of which happens with no user action at all. And
   * two kinds whose printers emit the same column names (`Name|Age` is common for
   * CRDs) are indistinguishable by name, so navigating between them reset
   * nothing. Optional: without it the names are still the best available key.
   */
  resetKey?: string
  /** In-flight list load: show "Loading…" instead of "No resources found". */
  loading?: boolean
  /**
   * Optional per-cell navigation: return a route to render the cell as a link
   * (events point their Object column at the involved object), null for plain
   * text. Called per visible cell on every render, so the caller memoizes.
   */
  cellLink?: (row: K8sTableRow, column: string, value: string) => RouteLocationRaw | null
}>()

const emit = defineEmits<{ rowClick: [row: K8sTableRow] }>()

const columnNamesKey = computed(() => props.columns.map((c) => c.name).join("|"))
// What "a different thing is being listed" means — see the resetKey prop.
const columnSetKey = computed(() => props.resetKey ?? columnNamesKey.value)

/**
 * Column ids: the column's own name, never its position. ResourceListPage
 * inserts and removes the synthetic Namespace column as the namespace selector
 * changes, which shifts every index while `resetKey` — the resource type, and
 * the only thing that resets anything here — stays the same. With positional
 * ids the stored sort and every drag-resized width then named columns that no
 * longer existed and were silently discarded: TanStack applies no sort at all
 * for an unknown id, and nothing re-arms an already-applied default, so pods
 * stopped coming up newest first the moment a namespace was picked (and again
 * on the way back to all-namespaces).
 *
 * A printer emitting the same header twice gets a suffixed id, so ids stay
 * unique whatever the server sends.
 */
const columnIds = computed(() => {
  const used = new Set<string>()
  return props.columns.map((col) => {
    let id = col.name
    for (let n = 2; used.has(id); n++) id = `${col.name}#${n}`
    used.add(id)
    return id
  })
})

// Columns that carry no information ("<none>"/empty in every row, e.g.
// Nominated Node / Readiness Gates on pods) are hidden automatically.
//
// Every watch event replaces the rows array, so this computed re-runs per
// event; a full rows × columns scan each time is wasted work at the 5000-row
// cap. Non-emptiness is treated as monotonic per column set: once a column
// has shown a value it stays visible (no layout jumps), and only
// still-hidden columns are rescanned. The memo is reset when the column set
// (resource type) changes.
//
// Keyed by column id rather than by index, for the same reason the ids
// themselves are: the Namespace column shifts every position without changing
// the resource type, which used to carry each column's verdict over onto its
// neighbour.
let nonEmptySeen = new Set<string>()
watch(columnSetKey, () => {
  nonEmptySeen = new Set()
})
const emptyColumnNames = computed(() => {
  if (props.rows.length === 0) return new Set<string>()
  const ids = columnIds.value
  const empty = new Set<string>()
  props.columns.forEach((col, index) => {
    const id = ids[index] as string
    if (col.name === "Name" || nonEmptySeen.has(id)) return
    const hasValue = props.rows.some((row) => {
      const text = cellText(row.cells[index]).trim()
      return text !== "" && text !== "<none>"
    })
    if (hasValue) nonEmptySeen.add(id) // benign memo write, monotonic
    else empty.add(col.name)
  })
  return empty
})

const visibleColumns = computed(() =>
  props.columns
    .map((col, index) => ({ col, index }))
    .filter(({ col }) => !emptyColumnNames.value.has(col.name)),
)

// Default widths follow the longest value per column and the full header
// text (Name gets a higher cap); manual drag-resize overrides them via
// columnSizing state.
//
// estimateColumnWidths runs canvas measureText over a bounded row sample —
// too expensive to repeat on every watch event (each event replaces the rows
// array). It is memoized on the column set plus the sampled row count (capped
// at SAMPLE_ROWS): widths refresh while the sample is still filling and on a
// resource-type switch, but a live table past the sample size stops
// re-measuring per event.
let cachedWidths: number[] = []
let cachedWidthsKey = ""
const defaultWidths = computed(() => {
  // Estimate over ALL columns so the width index lines up with row.cells
  // (which is indexed by original column position), then pick each visible
  // column's width by its original index. Passing only the visible subset here
  // would misalign every column after a hidden non-trailing one.
  // Keyed on the column names, not on resetKey: this memo is about the measured
  // content, so it must follow the columns actually being rendered.
  const key = `${columnNamesKey.value}#${Math.min(props.rows.length, SAMPLE_ROWS)}`
  if (key !== cachedWidthsKey) {
    cachedWidthsKey = key
    cachedWidths = estimateColumnWidths(props.columns, props.rows)
  }
  const widths = cachedWidths
  const ids = columnIds.value
  const byId = new Map<string, number>()
  visibleColumns.value.forEach(({ index }) => {
    byId.set(ids[index] as string, widths[index] as number)
  })
  return byId
})

// The defs feed useVueTable's `columns` getter, so their identity is what
// TanStack rebuilds every Column — and each row's cells — on. This computed's
// deps reach props.rows (through emptyColumnNames and defaultWidths), so it
// re-runs per watch event; the previous array is kept whenever nothing a def is
// built from changed, or a live table would rebuild the whole column model once
// per event. The key covers every def input: visible column identity, default
// size and description. The cell-view memo below keys its invalidation on this
// identity too, so it is dropped exactly when the Cell objects it holds are
// rebuilt.
let cachedDefs: ColumnDef<K8sTableRow, string>[] = []
let cachedDefsKey = ""
const columnDefs = computed<ColumnDef<K8sTableRow, string>[]>(() => {
  const widths = defaultWidths.value
  const ids = columnIds.value
  // The index is part of the key even though it is no longer part of the id:
  // accessorFn closes over it to read row.cells, so a def built for a shifted
  // column must not be reused.
  const key = JSON.stringify(
    visibleColumns.value.map(({ col, index }) => [
      index,
      ids[index],
      widths.get(ids[index] as string),
      col.description ?? "",
    ]),
  )
  if (key === cachedDefsKey) return cachedDefs
  cachedDefsKey = key
  cachedDefs = visibleColumns.value.map(({ col, index }) => ({
    id: ids[index] as string,
    header: col.name,
    accessorFn: (row: K8sTableRow) => cellText(row.cells[index]),
    cell: (info) => info.getValue(),
    // Ages ("5m", "44d") and numbers must sort numerically, not as strings.
    sortingFn: (rowA, rowB, columnId) =>
      compareTableValues(rowA.getValue<string>(columnId), rowB.getValue<string>(columnId)),
    size: widths.get(ids[index] as string) ?? 150,
    minSize: 50,
    maxSize: 900,
    meta: { description: col.description ?? "" },
  }))
  return cachedDefs
})

function defaultSorting(): SortingState {
  const wanted = props.defaultSort
  if (wanted === undefined) return []
  const match = props.columns.findIndex((c) => c.name === wanted.column)
  if (match < 0) return []
  return [{ id: columnIds.value[match] as string, desc: false }]
}

const sorting = ref<SortingState>([])
const columnSizing = ref<ColumnSizingState>({})

/**
 * The default sort names a column that may not be in this kind's column set at
 * all, so it can only be applied once the columns have actually arrived — and at
 * both moments it is asked for, they usually have not: useResourceList blanks `columns`
 * before every walk, so the first mount and every resource-type switch resolve
 * it against an empty list, where it silently means "no sort at all". So it
 * stays *pending* until the named column shows up, at most once per column set,
 * and never over a sort the user picked in the meantime.
 */
let defaultPending = true
function applyDefaultSort(): void {
  const next = defaultSorting()
  if (next.length === 0) return
  sorting.value = next
  defaultPending = false
}
applyDefaultSort()

// New resource type (different column set): drop manual resize overrides and
// re-arm the default sort. Clearing `sorting` here rather than resolving it is
// what makes the blanked-columns case correct — the previous kind's sort must
// not outlive it either way.
watch(columnSetKey, () => {
  columnSizing.value = {}
  sorting.value = []
  defaultPending = true
  applyDefaultSort()
})

// Declared after the reset watch so the two run in that order when a switch
// brings its columns along in the same flush.
watch(columnNamesKey, () => {
  if (defaultPending) applyDefaultSort()
})

const table = useVueTable({
  get data() {
    return props.rows
  },
  get columns() {
    return columnDefs.value
  },
  state: {
    get sorting() {
      return sorting.value
    },
    get globalFilter() {
      return props.globalFilter
    },
    get columnSizing() {
      return columnSizing.value
    },
  },
  onSortingChange: (updater) => {
    sorting.value = typeof updater === "function" ? updater(sorting.value) : updater
    // A header click is a decision: a default still pending (its column absent
    // so far — a kind whose printer emits no Age, say) must not land on top of
    // it if that column shows up in a later reload.
    defaultPending = false
  },
  onColumnSizingChange: (updater) => {
    columnSizing.value = typeof updater === "function" ? updater(columnSizing.value) : updater
  },
  enableColumnResizing: true,
  columnResizeMode: "onChange",
  globalFilterFn: "includesString",
  getCoreRowModel: getCoreRowModel(),
  getSortedRowModel: getSortedRowModel(),
  getFilteredRowModel: getFilteredRowModel(),
})

function headerTitle(header: { column: { columnDef: ColumnDef<K8sTableRow, string> } }): string {
  const def = header.column.columnDef
  const name = typeof def.header === "string" ? def.header : ""
  const description = (def.meta as { description?: string } | undefined)?.description ?? ""
  return description !== "" && description !== name ? `${name} — ${description}` : name
}

function cellRoute(cell: Cell<K8sTableRow, unknown>, value: string): RouteLocationRaw | null {
  if (props.cellLink === undefined) return null
  return props.cellLink(cell.row.original, String(cell.column.columnDef.header ?? ""), value)
}

// Whether a column carries statuses — and by which rule its cells are read —
// depends on the column alone, so it is resolved once per column set instead of
// once per rendered cell (a regex test per cell, ~240 per scroll frame).
// Derived from columnDefs, whose identity is content-keyed above and is what the
// cell-view memo below invalidates on.
const statusColumnKinds = computed(() => {
  const kinds = new Map<string, StatusColumnKind>()
  for (const def of columnDefs.value) {
    const header = typeof def.header === "string" ? def.header : ""
    const kind = statusColumnKind(header)
    if (def.id !== undefined && kind !== null) kinds.set(def.id, kind)
  }
  return kinds
})

interface CellView {
  cell: Cell<K8sTableRow, unknown>
  route: RouteLocationRaw | null
  /** The displayed value: the `title` attribute and a linked cell's body. */
  text: string
  /** The complete text-color class, fallback included (see above). */
  class: string
}

/**
 * Visible cells paired with everything the template needs per cell — route,
 * displayed text and resolved color class — computed once per cell per render
 * instead of inline in the markup, on the hot path of a virtualized table
 * (~30 rows × ~8 columns per scroll frame). The route used to be asked for
 * twice per cell (once in `v-if`, once for `:to`) and the value four times;
 * the class cost a regex test per cell plus, on status columns, a split and a
 * handful of substring scans per part. Same reason MetadataCard precomputes
 * `owners` and RecentEventsCard `rowsWithRoute`.
 *
 * Memoized per row, because building them allocates: without this, every scroll
 * frame builds ~30 arrays and ~240 wrapper objects for a route that is null on
 * every list but events. Keyed on the Row object, which TanStack rebuilds
 * exactly when `data` changes (sorting and filtering reuse the instances) — so
 * a row in the cache is a row whose cells and values are unchanged, which is
 * what covers the cached text and class. What is not covered by row identity is
 * invalidated by hand below: columnDefs identity (content-keyed above), which
 * changes exactly when TanStack rebuilds the Cell objects the cache holds — a
 * rows-only update no longer resets it — and is also what `statusColumnIds` is
 * derived from, so the class cannot outlive the column set it was resolved
 * against; and `cellLink`, rebuilt by its owner whenever it would resolve
 * differently (discovery loading, a namespace or cluster switch).
 */
let cellViewCache = new WeakMap<Row<K8sTableRow>, CellView[]>()
watch([() => props.cellLink, columnDefs], () => {
  cellViewCache = new WeakMap()
})

function cellViews(row: Row<K8sTableRow>): CellView[] {
  const cached = cellViewCache.get(row)
  if (cached !== undefined) return cached
  const kinds = statusColumnKinds.value
  const views = row.getVisibleCells().map((cell) => {
    const text = String(cell.getValue() ?? "")
    const kind = kinds.get(cell.column.id)
    return {
      cell,
      route: cellRoute(cell, text),
      text,
      class: (kind === undefined ? null : cellTextClass(kind, text)) ?? NEUTRAL_TEXT_CLASS,
    }
  })
  cellViewCache.set(row, views)
  return views
}

const totalWidth = computed(() => {
  // Track sizing state so the total refreshes during drag.
  void columnSizing.value
  void columnDefs.value
  return table.getTotalSize()
})

const scrollRef = ref<HTMLElement | null>(null)

const tableRows = computed(() => table.getRowModel().rows)

const virtualizer = useVirtualizer(
  computed(() => {
    // Read scrollRef here so the options recompute once the element mounts.
    const el = scrollRef.value
    return {
      count: tableRows.value.length,
      getScrollElement: () => el,
      estimateSize: () => 37,
      overscan: 12,
      initialRect: { width: 1024, height: 800 },
    }
  }),
)

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())
</script>

<template>
  <div ref="scrollRef" class="min-h-0 flex-1 overflow-auto" role="table">
    <div
      class="sticky top-0 z-10 flex border-b border-slate-200 bg-slate-100 text-sm dark:border-slate-700 dark:bg-slate-800"
      role="row"
      :style="{ minWidth: `${totalWidth}px` }"
    >
      <div
        v-for="header in table.getFlatHeaders()"
        :key="header.id"
        role="columnheader"
        class="relative flex shrink-0 cursor-pointer select-none items-center px-3 py-2 text-left font-semibold text-slate-600 dark:text-slate-300"
        :style="{ width: `${header.getSize()}px` }"
        :title="headerTitle(header)"
        @click="header.column.getToggleSortingHandler()?.($event)"
      >
        <span class="truncate">
          <FlexRender :render="header.column.columnDef.header" :props="header.getContext()" />
        </span>
        <span class="ml-1 shrink-0 text-xs">
          {{ header.column.getIsSorted() === "asc" ? "▲" : header.column.getIsSorted() === "desc" ? "▼" : "" }}
        </span>
        <!-- Visible grip over the column border: always discoverable. -->
        <span
          class="absolute -right-1 top-0 z-10 flex h-full w-2 cursor-col-resize touch-none items-center justify-center"
          aria-hidden="true"
          @click.stop
          @mousedown.stop="header.getResizeHandler()($event)"
          @touchstart.stop="header.getResizeHandler()($event)"
        >
          <span
            class="h-4/6 w-0.5 rounded bg-slate-300 hover:bg-blue-500 dark:bg-slate-500 dark:hover:bg-blue-400"
            :class="header.column.getIsResizing() ? '!bg-blue-500 dark:!bg-blue-400' : ''"
          ></span>
        </span>
      </div>
    </div>

    <div :style="{ height: `${totalSize}px`, position: 'relative', minWidth: `${totalWidth}px` }">
      <template
        v-for="virtualRow in virtualRows"
        :key="String(tableRows[virtualRow.index]?.id ?? virtualRow.index)"
      >
      <div
        v-if="tableRows[virtualRow.index]"
        role="row"
        class="absolute left-0 top-0 flex w-full cursor-pointer border-b border-slate-100 text-sm hover:bg-blue-50 dark:border-slate-800 dark:hover:bg-slate-800"
        :style="{ transform: `translateY(${virtualRow.start}px)`, minWidth: `${totalWidth}px` }"
        @click="emit('rowClick', tableRows[virtualRow.index]!.original)"
      >
        <div
          v-for="{ cell, route, text, class: cellClass } in cellViews(tableRows[virtualRow.index]!)"
          :key="cell.id"
          role="cell"
          class="shrink-0 truncate px-3 py-2"
          :class="cellClass"
          :style="{ width: `${cell.column.getSize()}px` }"
          :title="text"
        >
          <!-- Linked cell (e.g. an event's involved object): navigating to the
               referenced object must not also trigger the row click. -->
          <RouterLink
            v-if="route !== null"
            :to="route"
            class="text-blue-600 hover:underline dark:text-blue-400"
            @click.stop
          >
            {{ text }}
          </RouterLink>
          <!-- The plain cell is `text`, which the memo above already resolved:
               accessorFn returns cellText(...) — always a string — so FlexRender
               here only built one extra component instance per cell per frame to
               render exactly that. -->
          <template v-else>{{ text }}</template>
        </div>
      </div>
      </template>
    </div>
    <p v-if="loading && rows.length === 0" class="p-6 text-center text-sm text-slate-400">
      Loading…
    </p>
    <p v-else-if="rows.length === 0" class="p-6 text-center text-sm text-slate-400">
      No resources found.
    </p>
  </div>
</template>
