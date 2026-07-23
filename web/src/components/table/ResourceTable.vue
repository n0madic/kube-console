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
  type SortingState,
} from "@tanstack/vue-table"
import { useVirtualizer } from "@tanstack/vue-virtual"
import { computed, ref, watch } from "vue"
import type { RouteLocationRaw } from "vue-router"

import type { K8sTableColumn, K8sTableRow } from "@/api/types"
import { cellText, estimateColumnWidths, SAMPLE_ROWS } from "@/utils/columnWidths"
import { isStatusColumn, statusTextClass } from "@/utils/statusColors"
import { compareTableValues } from "@/utils/tableSort"

const props = defineProps<{
  columns: K8sTableColumn[]
  rows: K8sTableRow[]
  globalFilter: string
  hiddenColumns?: string[]
  /** Sort applied when the column set (resource type) changes. */
  defaultSort?: { column: string; desc: boolean }
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

const columnSetKey = computed(() => props.columns.map((c) => c.name).join("|"))

// Columns that carry no information ("<none>"/empty in every row, e.g.
// Nominated Node / Readiness Gates on pods) are hidden automatically.
//
// Every watch event replaces the rows array, so this computed re-runs per
// event; a full rows × columns scan each time is wasted work at the 5000-row
// cap. Non-emptiness is treated as monotonic per column set: once a column
// has shown a value it stays visible (no layout jumps), and only
// still-hidden columns are rescanned. The memo is reset when the column set
// (resource type) changes.
let nonEmptySeen = new Set<number>()
watch(columnSetKey, () => {
  nonEmptySeen = new Set()
})
const emptyColumnNames = computed(() => {
  if (props.rows.length === 0) return new Set<string>()
  const empty = new Set<string>()
  props.columns.forEach((col, index) => {
    if (col.name === "Name" || nonEmptySeen.has(index)) return
    const hasValue = props.rows.some((row) => {
      const text = cellText(row.cells[index]).trim()
      return text !== "" && text !== "<none>"
    })
    if (hasValue) nonEmptySeen.add(index) // benign memo write, monotonic
    else empty.add(col.name)
  })
  return empty
})

const visibleColumns = computed(() =>
  props.columns
    .map((col, index) => ({ col, index }))
    .filter(
      ({ col }) =>
        !(props.hiddenColumns ?? []).includes(col.name) && !emptyColumnNames.value.has(col.name),
    ),
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
  const key = `${columnSetKey.value}#${Math.min(props.rows.length, SAMPLE_ROWS)}`
  if (key !== cachedWidthsKey) {
    cachedWidthsKey = key
    cachedWidths = estimateColumnWidths(props.columns, props.rows)
  }
  const widths = cachedWidths
  const byId = new Map<string, number>()
  visibleColumns.value.forEach(({ col, index }) => {
    byId.set(`${index}-${col.name}`, widths[index] as number)
  })
  return byId
})

const columnDefs = computed<ColumnDef<K8sTableRow, string>[]>(() =>
  visibleColumns.value.map(({ col, index }) => ({
    id: `${index}-${col.name}`,
    header: col.name,
    accessorFn: (row: K8sTableRow) => cellText(row.cells[index]),
    cell: (info) => info.getValue(),
    // Ages ("5m", "44d") and numbers must sort numerically, not as strings.
    sortingFn: (rowA, rowB, columnId) =>
      compareTableValues(rowA.getValue<string>(columnId), rowB.getValue<string>(columnId)),
    size: defaultWidths.value.get(`${index}-${col.name}`) ?? 150,
    minSize: 50,
    maxSize: 900,
    meta: { description: col.description ?? "" },
  })),
)

function defaultSorting(): SortingState {
  const wanted = props.defaultSort
  if (wanted === undefined) return []
  const match = props.columns.findIndex((c) => c.name === wanted.column)
  if (match < 0) return []
  return [{ id: `${match}-${wanted.column}`, desc: wanted.desc }]
}

const sorting = ref<SortingState>(defaultSorting())
const columnSizing = ref<ColumnSizingState>({})

// New resource type (different column set): drop manual resize overrides and
// re-apply the default sort.
watch(columnSetKey, () => {
  columnSizing.value = {}
  sorting.value = defaultSorting()
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

function cellRoute(cell: Cell<K8sTableRow, unknown>): RouteLocationRaw | null {
  if (props.cellLink === undefined) return null
  return props.cellLink(
    cell.row.original,
    String(cell.column.columnDef.header ?? ""),
    String(cell.getValue() ?? ""),
  )
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
          v-for="cell in tableRows[virtualRow.index]!.getVisibleCells()"
          :key="cell.id"
          role="cell"
          class="shrink-0 truncate px-3 py-2"
          :class="
            (isStatusColumn(cell.column.columnDef.header as string)
              ? statusTextClass(String(cell.getValue() ?? ''))
              : null) ?? 'text-slate-700 dark:text-slate-300'
          "
          :style="{ width: `${cell.column.getSize()}px` }"
          :title="String(cell.getValue() ?? '')"
        >
          <!-- Linked cell (e.g. an event's involved object): navigating to the
               referenced object must not also trigger the row click. -->
          <RouterLink
            v-if="cellRoute(cell) !== null"
            :to="cellRoute(cell)!"
            class="text-blue-600 hover:underline dark:text-blue-400"
            @click.stop
          >
            {{ cell.getValue() }}
          </RouterLink>
          <FlexRender v-else :render="cell.column.columnDef.cell" :props="cell.getContext()" />
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
