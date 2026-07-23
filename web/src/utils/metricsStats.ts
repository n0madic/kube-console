/** min / avg / max over a metrics series for the currently displayed period. */
export interface SeriesStat {
  min: number | null
  avg: number | null
  max: number | null
}

/**
 * Compute min / avg / max over one series column of uPlot aligned data,
 * ignoring null gaps. `seriesIndex` is 0-based over the label list, so the
 * column read is `data[seriesIndex + 1]` (index 0 holds the x timestamps).
 * Returns nulls when the series has no finite samples.
 */
export function seriesStats(
  data: ReadonlyArray<ReadonlyArray<number | null>>,
  seriesIndex: number,
): SeriesStat {
  const col = data[seriesIndex + 1]
  if (col === undefined) return { min: null, avg: null, max: null }
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let count = 0
  for (const v of col) {
    if (v === null || !Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
    sum += v
    count++
  }
  if (count === 0) return { min: null, avg: null, max: null }
  return { min, avg: sum / count, max }
}
