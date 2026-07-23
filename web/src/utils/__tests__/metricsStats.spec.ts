import { describe, expect, it } from "vitest"

import { seriesStats } from "@/utils/metricsStats"

describe("seriesStats", () => {
  it("computes min/avg/max over a series column ignoring the x row", () => {
    const data = [
      [1, 2, 3, 4], // x timestamps — never read
      [10, 20, 30, 40], // series 0
      [5, 15, 25, 35], // series 1
    ]
    expect(seriesStats(data, 0)).toEqual({ min: 10, avg: 25, max: 40 })
    expect(seriesStats(data, 1)).toEqual({ min: 5, avg: 20, max: 35 })
  })

  it("skips null gaps", () => {
    const data = [
      [1, 2, 3, 4],
      [10, null, 30, null],
    ]
    expect(seriesStats(data, 0)).toEqual({ min: 10, avg: 20, max: 30 })
  })

  it("returns nulls for an all-null series", () => {
    const data = [
      [1, 2],
      [null, null],
    ]
    expect(seriesStats(data, 0)).toEqual({ min: null, avg: null, max: null })
  })

  it("returns nulls for an empty column", () => {
    expect(seriesStats([[], []], 0)).toEqual({ min: null, avg: null, max: null })
  })

  it("returns nulls for a missing column", () => {
    expect(seriesStats([[1, 2]], 0)).toEqual({ min: null, avg: null, max: null })
  })

  it("handles a single sample", () => {
    expect(seriesStats([[1], [42]], 0)).toEqual({ min: 42, avg: 42, max: 42 })
  })
})
