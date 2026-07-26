import { describe, expect, it } from "vitest"

import type { K8sTableColumn, K8sTableRow } from "@/api/types"
import {
  shouldShowNamespaceColumn,
  withNamespaceCells,
  withNamespaceColumn,
} from "@/utils/namespaceColumn"

const nativeColumns: K8sTableColumn[] = [
  { name: "Name", type: "string" },
  { name: "Ready", type: "string" },
  { name: "Age", type: "date" },
]

const fallbackColumns: K8sTableColumn[] = [
  { name: "Name", type: "string" },
  { name: "Namespace", type: "string" },
  { name: "Created", type: "date" },
  { name: "Status", type: "string" },
]

function row(namespace: string | undefined, cells: string[]): K8sTableRow {
  return {
    cells,
    object: { metadata: namespace === undefined ? {} : { namespace } },
  }
}

describe("shouldShowNamespaceColumn", () => {
  it("adds the column for a namespaced resource in all-namespaces mode", () => {
    expect(shouldShowNamespaceColumn(nativeColumns, true, true)).toBe(true)
  })

  it("does not add it when a specific namespace is selected", () => {
    expect(shouldShowNamespaceColumn(nativeColumns, false, true)).toBe(false)
  })

  it("does not add it for cluster-scoped resources", () => {
    expect(shouldShowNamespaceColumn(nativeColumns, true, false)).toBe(false)
  })

  it("does not duplicate an already-present Namespace column (List fallback)", () => {
    expect(shouldShowNamespaceColumn(fallbackColumns, true, true)).toBe(false)
  })
})

describe("withNamespaceColumn", () => {
  it("prepends the Namespace column without mutating the input", () => {
    const result = withNamespaceColumn(nativeColumns)
    expect(result.map((c) => c.name)).toEqual(["Namespace", "Name", "Ready", "Age"])
    expect(nativeColumns).toHaveLength(3) // input untouched
  })
})

describe("withNamespaceCells", () => {
  it("prepends each row's namespace as the first cell, keeping order and object", () => {
    const rows = [row("kube-system", ["coredns", "1/1", "5d"])]
    const result = withNamespaceCells(rows)
    expect(result[0]!.cells).toEqual(["kube-system", "coredns", "1/1", "5d"])
    expect(result[0]!.object?.metadata?.namespace).toBe("kube-system")
    expect(rows[0]!.cells).toHaveLength(3) // input untouched
  })

  it("keeps two identically named objects distinguishable by namespace", () => {
    const rows = [
      row("team-a", ["api", "1/1", "2d"]),
      row("team-b", ["api", "1/1", "9d"]),
    ]
    const result = withNamespaceCells(rows)
    expect(result[0]!.cells[0]).toBe("team-a")
    expect(result[1]!.cells[0]).toBe("team-b")
  })

  it("falls back to an empty cell when namespace metadata is missing", () => {
    const result = withNamespaceCells([row(undefined, ["orphan"])])
    expect(result[0]!.cells[0]).toBe("")
  })

  // A watch event replaces the whole rows array, so without a per-row memo the
  // entire collection (up to 5000 rows) was re-projected — two allocations each
  // — to absorb the single row that changed.
  it("reuses the projection of an unchanged row and rebuilds only the changed one", () => {
    const unchanged = row("team-a", ["api", "1/1"])
    const before = row("team-b", ["api", "0/1"])
    const first = withNamespaceCells([unchanged, before])

    // What one MODIFIED event produces: the same row objects but one replaced.
    const after = row("team-b", ["api", "1/1"])
    const second = withNamespaceCells([unchanged, after])

    expect(second[0]).toBe(first[0]) // same source row → same projection
    expect(second[1]).not.toBe(first[1])
    expect(second[1]!.cells).toEqual(["team-b", "api", "1/1"])
    expect(second[0]!.cells).toEqual(["team-a", "api", "1/1"])
  })

  it("returns a new array on every call", () => {
    // The table's memos hang off the data array's identity; reusing it would
    // leave stale cells on screen.
    const rows = [row("team-a", ["api"])]
    expect(withNamespaceCells(rows)).not.toBe(withNamespaceCells(rows))
  })
})
