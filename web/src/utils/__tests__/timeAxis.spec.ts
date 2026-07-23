import { describe, expect, it } from "vitest"

import { timeAxisLabels } from "@/utils/timeAxis"

// Assertions stay locale-agnostic: the point of the util is that the exact
// rendering comes from Intl, so only the structure is pinned here.
const MIN = 60
const DAY = 24 * 60 * MIN
// Local midnight, so the day rollover below is unambiguous in any timezone.
const midnightSec = new Date(2026, 6, 21, 0, 0, 0).getTime() / 1000

describe("timeAxisLabels", () => {
  it("puts the date on the first tick only while the day does not change", () => {
    const splits = [midnightSec + 3600, midnightSec + 7200, midnightSec + 10800]
    const labels = timeAxisLabels(splits, 60 * MIN)
    expect(labels[0]).toContain("\n")
    expect(labels[1]).not.toContain("\n")
    expect(labels[2]).not.toContain("\n")
  })

  it("repeats the date when the day rolls over", () => {
    const splits = [midnightSec + 23 * 3600, midnightSec + DAY, midnightSec + DAY + 3600]
    const labels = timeAxisLabels(splits, 60 * MIN)
    expect(labels[0]).toContain("\n")
    expect(labels[1]).toContain("\n")
    expect(labels[2]).not.toContain("\n")
  })

  it("adds seconds only for sub-minute tick intervals", () => {
    const splits = [midnightSec + 15, midnightSec + 30]
    const coarse = timeAxisLabels(splits, MIN)
    const fine = timeAxisLabels(splits, 15)
    // Two colon-separated parts at minute resolution, three with seconds.
    expect((coarse[1] ?? "").split(":").length).toBe(2)
    expect((fine[1] ?? "").split(":").length).toBe(3)
  })

  it("never uses the US am/pm stamps uPlot hardcodes when the locale is 24h", () => {
    const labels = timeAxisLabels([midnightSec + 19 * 3600], 60 * MIN)
    const timePart = (labels[0] ?? "").split("\n")[0] ?? ""
    const expected = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date((midnightSec + 19 * 3600) * 1000))
    expect(timePart).toBe(expected)
  })
})
