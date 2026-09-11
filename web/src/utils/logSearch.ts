// In-app search over the log buffer, and highlighting of the hits.
//
// The viewer is virtualized, so the browser's own Find only ever sees the
// ~100 rows in the DOM; searching has to run over the buffer the stream holds
// instead, and the rows on screen are painted from the verdicts. Everything
// here is pure: which lines match, where in a line, and how a line's tokens
// split around the hits.

import { logTokenClass, type LogToken } from "@/utils/logJson"

export interface LogQuery {
  /** The text as typed, for display and for change detection. */
  source: string
  /** Case-insensitive, for the per-line yes/no. */
  test: RegExp
  /** The same pattern, global, for the offsets within a matching line. */
  all: RegExp
}

/**
 * Compiles a search string, or returns null when there is nothing to search
 * for (empty or whitespace-only). Plain substring semantics: every regex
 * metacharacter is escaped.
 *
 * A regex with the `i` flag rather than `toLowerCase().includes`: Unicode
 * case folding can change a string's length (`İ` lowercases to two code
 * units), which would shift every highlight offset after it, while a regex
 * reports offsets against the original text — and `.test` allocates nothing
 * per line.
 */
export function compileQuery(raw: string): LogQuery | null {
  if (raw.trim() === "") return null
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return { source: raw, test: new RegExp(escaped, "i"), all: new RegExp(escaped, "gi") }
}

export function lineMatches(q: LogQuery, line: string): boolean {
  return q.test.test(line)
}

export type Range = readonly [start: number, end: number]

/** Non-overlapping hit offsets within one line, ascending. */
export function matchRanges(q: LogQuery, line: string): Range[] {
  const ranges: Range[] = []
  const re = q.all
  // A global regex carries its position between calls; every line starts over.
  re.lastIndex = 0
  for (;;) {
    const m = re.exec(line)
    if (m === null) break
    const start = m.index
    const end = start + m[0].length
    ranges.push([start, end])
    // The query is never empty, so the match is never zero-length and the
    // loop always advances.
    re.lastIndex = end
  }
  return ranges
}

/** Ascending indices of the lines matching `q`, starting at `from`. */
export function scanLines(lines: readonly string[], q: LogQuery, from = 0): number[] {
  const hits: number[] = []
  for (let i = Math.max(0, from); i < lines.length; i++) {
    if (q.test.test(lines[i] ?? "")) hits.push(i)
  }
  return hits
}

export interface LineSegment {
  text: string
  /** Color class of the token this piece belongs to, "" for plain text. */
  cls: string
  /** Inside a search hit. */
  hit: boolean
}

/**
 * Splits a line into renderable pieces: the JSON tokens (or the whole line as
 * one plain piece), each cut at the boundaries of the hit ranges. The
 * concatenation of the segments' text is always the input line — highlighting
 * never rewrites what the container logged, the same rule `tokenizeJsonLine`
 * keeps.
 */
export function segmentLine(
  text: string,
  tokens: LogToken[] | null,
  ranges: Range[],
): LineSegment[] {
  const pieces: { text: string; cls: string }[] =
    tokens === null
      ? [{ text, cls: "" }]
      : tokens.map((t) => ({ text: t.text, cls: logTokenClass(t) }))
  if (ranges.length === 0) return pieces.map((p) => ({ ...p, hit: false }))

  const segments: LineSegment[] = []
  let pos = 0 // offset of the current piece within the line
  let r = 0 // first range that may still overlap the current position
  for (const piece of pieces) {
    const pieceEnd = pos + piece.text.length
    let cursor = pos
    while (cursor < pieceEnd) {
      // Skip ranges that ended before the cursor.
      while (r < ranges.length && ranges[r]![1] <= cursor) r++
      const range = ranges[r]
      if (range === undefined || range[0] >= pieceEnd) {
        segments.push({ text: text.slice(cursor, pieceEnd), cls: piece.cls, hit: false })
        cursor = pieceEnd
        break
      }
      const hitStart = Math.max(range[0], cursor)
      if (hitStart > cursor) {
        segments.push({ text: text.slice(cursor, hitStart), cls: piece.cls, hit: false })
      }
      const hitEnd = Math.min(range[1], pieceEnd)
      segments.push({ text: text.slice(hitStart, hitEnd), cls: piece.cls, hit: true })
      cursor = hitEnd
    }
    pos = pieceEnd
  }
  return segments
}
