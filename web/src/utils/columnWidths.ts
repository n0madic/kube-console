// Content-based default column widths: each column is as wide as its longest
// value or its full header (clamped), the Name column gets a higher cap.
// Text is measured precisely via canvas measureText (with a char-count
// fallback for environments without canvas). Users can still resize by
// dragging; these are only the defaults.

import type { K8sTableColumn, K8sTableRow } from "@/api/types"

export const COLUMN_MIN_PX = 60
export const COLUMN_MAX_PX = 380
export const NAME_COLUMN_MAX_PX = 640
const NAME_COLUMN_MIN_PX = 140

const CELL_EXTRA_PX = 36 // px-3 padding + rounding/kerning slack
const HEADER_EXTRA_PX = 42 // px-3 padding + sort indicator
const FALLBACK_CHAR_PX = 7.5
const FALLBACK_HEADER_CHAR_PX = 8.4
export const SAMPLE_ROWS = 200

const CELL_FONT = '14px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const HEADER_FONT = `600 ${CELL_FONT}`

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

let canvasCtx: CanvasRenderingContext2D | null | undefined

function measureCtx(): CanvasRenderingContext2D | null {
  if (canvasCtx === undefined) {
    try {
      canvasCtx = document.createElement("canvas").getContext("2d")
    } catch {
      canvasCtx = null
    }
  }
  return canvasCtx
}

function textPx(text: string, font: string, fallbackCharPx: number): number {
  const ctx = measureCtx()
  if (ctx === null) return fallbackCharPx * text.length
  ctx.font = font
  return ctx.measureText(text).width
}

/**
 * Estimate pixel widths for every column (same order as columns) from the
 * longest cell value in a bounded row sample and the full header text.
 */
export function estimateColumnWidths(columns: K8sTableColumn[], rows: K8sTableRow[]): number[] {
  // Top candidates per column by char count (cheap proxy); the widest of
  // them by real measurement wins — char count alone can undershoot when a
  // shorter string uses wider glyphs.
  const CANDIDATES = 3
  const candidates: string[][] = columns.map(() => [])
  const sample = rows.length > SAMPLE_ROWS ? rows.slice(0, SAMPLE_ROWS) : rows
  for (const row of sample) {
    for (let i = 0; i < columns.length; i++) {
      const text = cellText(row.cells[i])
      const list = candidates[i] as string[]
      if (list.length < CANDIDATES) {
        if (!list.includes(text)) list.push(text)
        continue
      }
      let shortest = 0
      for (let j = 1; j < list.length; j++) {
        if ((list[j] as string).length < (list[shortest] as string).length) shortest = j
      }
      if (text.length > (list[shortest] as string).length && !list.includes(text)) {
        list[shortest] = text
      }
    }
  }
  return columns.map((col, i) => {
    const isName = col.name === "Name"
    const min = isName ? NAME_COLUMN_MIN_PX : COLUMN_MIN_PX
    const max = isName ? NAME_COLUMN_MAX_PX : COLUMN_MAX_PX
    let valuePx = 0
    for (const text of candidates[i] as string[]) {
      const px = textPx(text, CELL_FONT, FALLBACK_CHAR_PX)
      if (px > valuePx) valuePx = px
    }
    valuePx += CELL_EXTRA_PX
    const headerPx = HEADER_EXTRA_PX + textPx(col.name, HEADER_FONT, FALLBACK_HEADER_CHAR_PX)
    return Math.ceil(Math.min(max, Math.max(min, valuePx, headerPx)))
  })
}
