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

/** Prepend each row's namespace (from object metadata) as the first cell. */
export function withNamespaceCells(rows: K8sTableRow[]): K8sTableRow[] {
  return rows.map((row) => ({
    ...row,
    cells: [row.object?.metadata?.namespace ?? "", ...row.cells],
  }))
}
