// Convert a Kubernetes Table into compact rows for the detail-page mini-tables
// (NodePodsCard, RelatedResourcesCard). Columns come from the server printer,
// so this stays universal — no per-kind hardcoding. The Name column is dropped
// here because it is rendered as a navigation link by the component.

import type { K8sObjectMeta, K8sTable } from "@/api/types"

export interface MiniRow {
  name: string
  namespace: string
  cells: string[]
}

export interface MiniTable {
  columns: string[]
  rows: MiniRow[]
}

function cellText(cell: unknown): string {
  return cell === null || cell === undefined || typeof cell === "object" ? "" : String(cell)
}

interface ToMiniOptions {
  /**
   * Keep only these server columns, in this order (case-insensitive), including
   * wide ones. When omitted, all priority-0 columns are kept in server order.
   */
  keepOnly?: string[]
  /** Extra column names to drop (case-insensitive). "Name" is always dropped. */
  drop?: string[]
  /** Keep only rows whose object metadata passes this predicate. */
  rowFilter?: (meta: K8sObjectMeta) => boolean
}

/** Selected server columns as {index, name}, honoring keepOnly/priority/drop. */
function selectColumns(table: K8sTable, opts: ToMiniOptions): Array<{ index: number; name: string }> {
  const defs = table.columnDefinitions ?? []
  if (opts.keepOnly !== undefined) {
    return opts.keepOnly.flatMap((wanted) => {
      const index = defs.findIndex((d) => d.name.toLowerCase() === wanted.toLowerCase())
      const def = defs[index]
      return index >= 0 && def !== undefined ? [{ index, name: def.name }] : []
    })
  }
  const drop = new Set([...(opts.drop ?? []), "Name"].map((s) => s.toLowerCase()))
  return defs.flatMap((def, index) =>
    (def.priority ?? 0) === 0 && !drop.has(def.name.toLowerCase()) ? [{ index, name: def.name }] : [],
  )
}

export function tableToMini(table: K8sTable, opts: ToMiniOptions = {}): MiniTable {
  const selected = selectColumns(table, opts)
  const rows = (table.rows ?? [])
    .filter((row) => opts.rowFilter === undefined || opts.rowFilter(row.object?.metadata ?? {}))
    .map((row): MiniRow => {
      const meta = row.object?.metadata
      return {
        name: meta?.name ?? "",
        namespace: meta?.namespace ?? "",
        cells: selected.map((c) => cellText(row.cells[c.index])),
      }
    })
  return { columns: selected.map((c) => c.name), rows }
}
