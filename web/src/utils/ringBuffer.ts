// In-memory metric series ring buffer: max 240 samples, deduplicated by the
// source metric timestamp. Never persisted; a shared in-memory cache
// (metricsCache.ts) can keep a buffer alive across component mounts, so it
// survives navigation and tab switches within a tab, but a page refresh
// starts fresh.

export const MAX_SAMPLES = 240

/**
 * Aligned multi-series ring buffer (e.g. pod aggregate + per-container lines).
 * Samples are deduplicated by source timestamp and the oldest are evicted past
 * MAX_SAMPLES. Every chart owner uses this one — a single-series variant would
 * be the same buffer with one label.
 */
export class MultiSeriesRingBuffer {
  private timestamps: number[] = []
  private series = new Map<string, Array<number | null>>()

  push(timestampMs: number, values: Record<string, number>): boolean {
    const last = this.timestamps[this.timestamps.length - 1]
    if (last !== undefined && timestampMs <= last) return false
    this.timestamps.push(timestampMs)
    // Backfill new labels so every series stays aligned with timestamps.
    for (const label of Object.keys(values)) {
      if (!this.series.has(label)) {
        this.series.set(label, new Array<number | null>(this.timestamps.length - 1).fill(null))
      }
    }
    for (const [label, points] of this.series) {
      points.push(values[label] ?? null)
    }
    if (this.timestamps.length > MAX_SAMPLES) {
      this.timestamps.shift()
      for (const points of this.series.values()) points.shift()
    }
    return true
  }

  get length(): number {
    return this.timestamps.length
  }

  /** Newest sample timestamp (ms), or null when empty — used for cache TTL. */
  lastTimestamp(): number | null {
    const last = this.timestamps[this.timestamps.length - 1]
    return last ?? null
  }

  labels(): string[] {
    return [...this.series.keys()]
  }

  /**
   * uPlot aligned data: [xs (seconds), ...series in labels() order],
   * optionally windowed to the last rangeSeconds.
   */
  toUplotData(rangeSeconds?: number): Array<Array<number | null>> {
    let from = 0
    if (rangeSeconds !== undefined && this.timestamps.length > 0) {
      const cutoff = (this.timestamps[this.timestamps.length - 1] as number) - rangeSeconds * 1000
      from = this.timestamps.findIndex((t) => t >= cutoff)
      if (from < 0) from = 0
    }
    const xs = this.timestamps.slice(from).map((t) => t / 1000)
    const out: Array<Array<number | null>> = [xs]
    for (const points of this.series.values()) {
      out.push(points.slice(from))
    }
    return out
  }
}
