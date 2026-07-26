// When a namespaced resource is listed across all namespaces, the Kubernetes
// Table API returns no Namespace column — kubectl adds it client-side for
// `get -A`. Without it, identically named objects from different namespaces
// collapse into an indistinguishable list. These helpers inject a Namespace
// column (first, kubectl order) from each row's object metadata.

import type { K8sTableColumn, K8sTableRow } from "@/api/types"

const NAMESPACE_COLUMN_NAME = "Namespace"

/**
 * Whether to inject a Namespace column: only in all-namespaces mode, only for
 * namespaced resources, and never when the column set already carries one (the
 * List→Table fallback in `tableFallback.ts` includes it, as may some CRDs).
 */
export function shouldShowNamespaceColumn(
  columns: K8sTableColumn[],
  allNamespaces: boolean,
  namespaced: boolean,
): boolean {
  return (
    allNamespaces &&
    namespaced &&
    !columns.some((c) => c.name === NAMESPACE_COLUMN_NAME)
  )
}

/** Prepend the Namespace column definition. */
export function withNamespaceColumn(columns: K8sTableColumn[]): K8sTableColumn[] {
  return [{ name: NAMESPACE_COLUMN_NAME, type: "string" }, ...columns]
}

// Projections memoized per source row. Every watch event hands the list page a
// new rows array (useResourceList must change its identity so the table
// rebuilds), so the whole collection was re-projected per event — a row object
// and a cells array allocated for each of up to 5000 rows to absorb the one that
// actually changed. Same shape as ResourceTable's per-row cell-view memo.
//
// Module-level, and shared by every mounted list page, which is safe because the
// projection is a pure function of the row: the same row object can only ever
// yield the same cells, so two pages listing the same objects hit an identical
// result rather than poisoning each other. Rows are never mutated in place (a
// watch event carries a freshly parsed object), and a WeakMap keeps nothing
// alive past the collection holding it.
//
// An unchanged row keeping its projected identity does NOT help ResourceTable's
// cell-view memo — that is keyed on TanStack Row objects, which are rebuilt
// whenever the data array identity changes. The saving here is the allocations.
const projectedRows = new WeakMap<K8sTableRow, K8sTableRow>()

/** Prepend each row's namespace (from object metadata) as the first cell. */
export function withNamespaceCells(rows: K8sTableRow[]): K8sTableRow[] {
  return rows.map((row) => {
    const cached = projectedRows.get(row)
    if (cached !== undefined) return cached
    const projected: K8sTableRow = {
      ...row,
      cells: [row.object?.metadata?.namespace ?? "", ...row.cells],
    }
    projectedRows.set(row, projected)
    return projected
  })
}
