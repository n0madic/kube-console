import { describe, expect, it } from "vitest"

import { MAX_SAMPLES, MultiSeriesRingBuffer } from "@/utils/ringBuffer"

describe("MultiSeriesRingBuffer", () => {
  it("keeps series aligned and dedups by timestamp", () => {
    const buf = new MultiSeriesRingBuffer()
    expect(buf.push(1000, { total: 10, app: 7 })).toBe(true)
    expect(buf.push(1000, { total: 11, app: 8 })).toBe(false) // same timestamp
    expect(buf.push(500, { total: 99, app: 99 })).toBe(false) // older timestamp
    expect(buf.push(2000, { total: 12, app: 9 })).toBe(true)
    expect(buf.length).toBe(2)
    const [xs, total, app] = buf.toUplotData()
    expect(xs).toEqual([1, 2])
    expect(total).toEqual([10, 12])
    expect(app).toEqual([7, 9])
  })

  it("backfills nulls when a new series appears mid-stream", () => {
    const buf = new MultiSeriesRingBuffer()
    buf.push(1000, { total: 10 })
    buf.push(2000, { total: 12, sidecar: 3 })
    expect(buf.labels()).toEqual(["total", "sidecar"])
    const data = buf.toUplotData()
    expect(data[1]).toEqual([10, 12])
    expect(data[2]).toEqual([null, 3])
  })

  it("evicts across all series beyond MAX_SAMPLES", () => {
    const buf = new MultiSeriesRingBuffer()
    for (let i = 0; i < MAX_SAMPLES + 5; i++) {
      buf.push((i + 1) * 1000, { a: i, b: i * 2 })
    }
    expect(buf.length).toBe(MAX_SAMPLES)
    const data = buf.toUplotData()
    expect(data[0]?.length).toBe(MAX_SAMPLES)
    expect(data[1]?.length).toBe(MAX_SAMPLES)
    expect(data[2]?.length).toBe(MAX_SAMPLES)
  })

  it("windows data to the requested range", () => {
    const buf = new MultiSeriesRingBuffer()
    buf.push(0, { a: 0 })
    buf.push(100_000, { a: 1 })
    buf.push(200_000, { a: 2 })
    const data = buf.toUplotData(150) // last 150 seconds
    expect(data[0]).toEqual([100, 200])
    expect(data[1]).toEqual([1, 2])
  })

  it("reports the newest timestamp, null when empty", () => {
    const buf = new MultiSeriesRingBuffer()
    expect(buf.lastTimestamp()).toBeNull()
    buf.push(1000, { a: 1 })
    buf.push(2000, { a: 2 })
    expect(buf.lastTimestamp()).toBe(2000)
    // A rejected dedup push must not advance the reported timestamp.
    expect(buf.push(2000, { a: 3 })).toBe(false)
    expect(buf.lastTimestamp()).toBe(2000)
  })
})
