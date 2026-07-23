import { describe, expect, it } from "vitest"

import { compareTableValues, parseK8sAge } from "@/utils/tableSort"

describe("parseK8sAge", () => {
  it("parses kubectl-style ages into seconds", () => {
    expect(parseK8sAge("30s")).toBe(30)
    expect(parseK8sAge("5m")).toBe(300)
    expect(parseK8sAge("2m30s")).toBe(150)
    expect(parseK8sAge("3h")).toBe(10800)
    expect(parseK8sAge("44d")).toBe(44 * 86400)
    expect(parseK8sAge("2d3h")).toBe(2 * 86400 + 3 * 3600)
  })

  it("rejects non-age strings", () => {
    for (const v of ["Running", "1/1", "", "5 m", "m5", "10.5s2", "<none>"]) {
      expect(parseK8sAge(v), v).toBeNull()
    }
  })
})

describe("compareTableValues", () => {
  it("sorts ages numerically, not lexicographically", () => {
    // Lexicographic order would put "44d" before "5m".
    expect(compareTableValues("5m", "44d")).toBeLessThan(0)
    expect(compareTableValues("30s", "5m")).toBeLessThan(0)
    expect(compareTableValues("2m30s", "2m")).toBeGreaterThan(0)
  })

  it("sorts plain numbers numerically", () => {
    expect(compareTableValues("9", "10")).toBeLessThan(0)
  })

  it("falls back to locale compare for text", () => {
    expect(compareTableValues("alpha", "beta")).toBeLessThan(0)
  })

  it("pushes empty-ish values to the end", () => {
    expect(compareTableValues("<none>", "5m")).toBeGreaterThan(0)
    expect(compareTableValues("5m", "")).toBeLessThan(0)
    expect(compareTableValues("<none>", "<unknown>")).toBe(0)
  })

  // Regression: number/number compared numerically while number/other fell
  // back to localeCompare, producing the cycle 10 > 9 > "1m" > 10 — a
  // non-transitive comparator garbles Array.prototype.sort results.
  it("stays transitive when a column mixes numbers and ages", () => {
    expect(compareTableValues("10", "9")).toBeGreaterThan(0)
    // Mixed shapes rank numbers before ages — both comparisons must agree.
    expect(compareTableValues("9", "1m")).toBeLessThan(0)
    expect(compareTableValues("10", "1m")).toBeLessThan(0)
  })

  it("sorts every permutation of a mixed column identically", () => {
    const expected = ["9", "10", "1m"]
    const permutations = [
      ["10", "9", "1m"],
      ["10", "1m", "9"],
      ["9", "10", "1m"],
      ["9", "1m", "10"],
      ["1m", "10", "9"],
      ["1m", "9", "10"],
    ]
    for (const p of permutations) {
      expect([...p].sort(compareTableValues), p.join(",")).toEqual(expected)
    }
  })

  it("orders a RESTARTS-style mix as numbers, then plain strings", () => {
    // "3 (2m ago)" is neither a number nor a pure age token — it ranks after
    // the numeric cells instead of interleaving lexicographically.
    const sorted = ["3 (2m ago)", "10", "9"].sort(compareTableValues)
    expect(sorted).toEqual(["9", "10", "3 (2m ago)"])
  })
})
