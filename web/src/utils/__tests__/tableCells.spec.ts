import { describe, expect, it } from "vitest"

import { cellText, scalarCellText } from "@/utils/tableCells"

describe("tableCells", () => {
  it("renders scalars as text and absent cells as empty", () => {
    for (const fn of [cellText, scalarCellText]) {
      expect(fn("Running")).toBe("Running")
      expect(fn(3)).toBe("3")
      expect(fn(false)).toBe("false")
      expect(fn(null)).toBe("")
      expect(fn(undefined)).toBe("")
      expect(fn("")).toBe("")
    }
  })

  // The one difference between them, and the reason there are two: the display
  // reading shows an odd cell, the judging reading abstains on it. Anything that
  // collapses these back into one function breaks one of the two callers —
  // podHealth would classify a JSON blob as a failure status.
  it("splits on non-scalar cells: JSON for display, empty for judgement", () => {
    expect(cellText({ a: 1 })).toBe('{"a":1}')
    expect(cellText([1, "x"])).toBe('[1,"x"]')
    expect(scalarCellText({ a: 1 })).toBe("")
    expect(scalarCellText([1, "x"])).toBe("")
  })
})
