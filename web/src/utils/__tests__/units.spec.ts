import { describe, expect, it } from "vitest"

import { formatAge, formatCores, formatRelativeAge, parseQuantity } from "@/utils/units"

const now = new Date("2026-07-20T12:00:00Z")

describe("parseQuantity", () => {
  it("parses plain integers and decimals as base units", () => {
    expect(parseQuantity("8")).toBe(8)
    expect(parseQuantity("110")).toBe(110)
    expect(parseQuantity("0")).toBe(0)
    expect(parseQuantity(4)).toBe(4)
  })

  it("applies decimal SI suffixes (milli/kilo/mega/giga)", () => {
    expect(parseQuantity("7910m")).toBeCloseTo(7.91, 5)
    expect(parseQuantity("500m")).toBeCloseTo(0.5, 5)
    expect(parseQuantity("2k")).toBe(2000)
    expect(parseQuantity("16G")).toBe(16_000_000_000)
  })

  it("applies binary suffixes (Ki/Mi/Gi)", () => {
    expect(parseQuantity("1Ki")).toBe(1024)
    expect(parseQuantity("32861328Ki")).toBe(32_861_328 * 1024)
    expect(parseQuantity("30Gi")).toBe(30 * 1024 ** 3)
  })

  it("returns NaN for missing or unparseable input", () => {
    expect(parseQuantity(undefined)).toBeNaN()
    expect(parseQuantity("")).toBeNaN()
    expect(parseQuantity("abc")).toBeNaN()
    expect(parseQuantity("10Xi")).toBeNaN()
  })
})

describe("formatCores", () => {
  it("keeps integers bare and rounds fractions to 2 decimals", () => {
    expect(formatCores(8)).toBe("8")
    expect(formatCores(0.82)).toBe("0.82")
    expect(formatCores(7.905)).toBe("7.91")
  })
})

describe("formatAge", () => {
  it("clamps future timestamps to 0s (always-past callers)", () => {
    expect(formatAge("2026-07-20T13:00:00Z", now)).toBe("0s")
    expect(formatAge("2026-07-20T11:30:00Z", now)).toBe("30m")
  })

  it("returns empty for missing or invalid input", () => {
    expect(formatAge(undefined, now)).toBe("")
    expect(formatAge("", now)).toBe("")
    expect(formatAge("not-a-date", now)).toBe("")
  })
})

describe("formatRelativeAge", () => {
  it("suffixes past timestamps with 'ago'", () => {
    expect(formatRelativeAge("2026-07-20T09:00:00Z", now)).toBe("3h ago")
  })

  it("prefixes future timestamps with 'in' instead of clamping to 0s", () => {
    expect(formatRelativeAge("2026-07-20T13:30:00Z", now)).toBe("in 1h30m")
    expect(formatRelativeAge("2026-10-18T12:00:00Z", now)).toBe("in 90d")
  })

  it("returns empty for missing or invalid input", () => {
    expect(formatRelativeAge(undefined, now)).toBe("")
    expect(formatRelativeAge("nope", now)).toBe("")
  })
})
