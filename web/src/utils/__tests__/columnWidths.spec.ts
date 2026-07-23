import { describe, expect, it } from "vitest"

import type { K8sTableRow } from "@/api/types"
import {
  COLUMN_MAX_PX,
  COLUMN_MIN_PX,
  NAME_COLUMN_MAX_PX,
  estimateColumnWidths,
} from "@/utils/columnWidths"

function rows(cells: Array<Array<string | number>>): K8sTableRow[] {
  return cells.map((c) => ({ cells: c }))
}

describe("estimateColumnWidths", () => {
  it("sizes each column to its longest value", () => {
    const widths = estimateColumnWidths(
      [
        { name: "Name", type: "string" },
        { name: "Ready", type: "string" },
      ],
      rows([
        ["short", "1/1"],
        ["a-much-longer-resource-name", "1/1"],
      ]),
    )
    expect(widths[0]).toBeGreaterThan(widths[1] as number)
    // Narrow column shrinks to its content, not an equal share.
    expect(widths[1]).toBeLessThan(120)
    expect(widths[1]).toBeGreaterThanOrEqual(COLUMN_MIN_PX)
  })

  it("caps regular columns at COLUMN_MAX_PX and Name higher", () => {
    const huge = "x".repeat(500)
    const widths = estimateColumnWidths(
      [
        { name: "Name", type: "string" },
        { name: "Message", type: "string" },
      ],
      rows([[huge, huge]]),
    )
    expect(widths[0]).toBe(NAME_COLUMN_MAX_PX)
    expect(widths[1]).toBe(COLUMN_MAX_PX)
    expect(NAME_COLUMN_MAX_PX).toBeGreaterThan(COLUMN_MAX_PX)
  })

  it("never goes below the minimum even for empty columns", () => {
    const widths = estimateColumnWidths([{ name: "X", type: "string" }], rows([[""]]))
    expect(widths[0]).toBeGreaterThanOrEqual(COLUMN_MIN_PX)
  })

  it("accounts for header length when values are short", () => {
    const widths = estimateColumnWidths(
      [{ name: "A-Very-Long-Column-Header-Name", type: "string" }],
      rows([["x"]]),
    )
    expect(widths[0]).toBeGreaterThan(COLUMN_MIN_PX + 50)
  })
})
