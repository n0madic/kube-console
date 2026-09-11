import { describe, expect, it } from "vitest"

import { tokenizeJsonLine } from "@/utils/logJson"
import {
  compileQuery,
  lineMatches,
  matchRanges,
  scanLines,
  segmentLine,
  type LogQuery,
} from "@/utils/logSearch"

function q(raw: string): LogQuery {
  const compiled = compileQuery(raw)
  if (compiled === null) throw new Error(`query ${JSON.stringify(raw)} compiled to null`)
  return compiled
}

describe("compileQuery", () => {
  it("returns null for an empty or whitespace-only query", () => {
    expect(compileQuery("")).toBeNull()
    expect(compileQuery("   ")).toBeNull()
    expect(compileQuery("\t\n")).toBeNull()
  })

  it("keeps the raw text as source", () => {
    expect(q("Error 42").source).toBe("Error 42")
  })

  it("treats regex metacharacters literally", () => {
    const query = q("a.b")
    expect(lineMatches(query, "a.b")).toBe(true)
    expect(lineMatches(query, "axb")).toBe(false)
    expect(lineMatches(q("(x)"), "call (x) here")).toBe(true)
    expect(lineMatches(q("[a]"), "index a")).toBe(false)
  })

  it("matches case-insensitively", () => {
    expect(lineMatches(q("error"), "ERROR: boom")).toBe(true)
    expect(lineMatches(q("ERROR"), "an error here")).toBe(true)
  })
})

describe("matchRanges", () => {
  it("reports every non-overlapping hit in ascending order", () => {
    expect(matchRanges(q("ab"), "ab xx ab")).toEqual([
      [0, 2],
      [6, 8],
    ])
  })

  it("reports adjacent hits separately", () => {
    expect(matchRanges(q("ab"), "abab")).toEqual([
      [0, 2],
      [2, 4],
    ])
  })

  it("returns an empty list with no hit", () => {
    expect(matchRanges(q("zz"), "abc")).toEqual([])
  })

  it("is stable across repeated calls on the same query", () => {
    const query = q("a")
    expect(matchRanges(query, "aa")).toHaveLength(2)
    // A global regex's lastIndex must not leak from one line into the next.
    expect(matchRanges(query, "a")).toEqual([[0, 1]])
  })

  it("keeps offsets against the original text when case folding changes the length", () => {
    // "İ".toLowerCase() is two code units, so a lowercase-and-includes
    // implementation would shift every offset after it.
    const line = "İstanbul error here"
    const ranges = matchRanges(q("error"), line)
    expect(ranges).toEqual([[9, 14]])
    expect(line.slice(9, 14)).toBe("error")
  })
})

describe("scanLines", () => {
  it("returns the indices of matching lines", () => {
    expect(scanLines(["x", "hit", "y", "HIT"], q("hit"))).toEqual([1, 3])
  })

  it("starts from the given index", () => {
    expect(scanLines(["hit", "hit", "x", "hit"], q("hit"), 2)).toEqual([3])
  })

  it("returns nothing past the end", () => {
    expect(scanLines(["hit"], q("hit"), 5)).toEqual([])
  })
})

describe("segmentLine", () => {
  function joined(text: string, tokens: ReturnType<typeof tokenizeJsonLine>, query: LogQuery | null) {
    const segments = segmentLine(text, tokens, query === null ? [] : matchRanges(query, text))
    return { segments, text: segments.map((s) => s.text).join("") }
  }

  it("emits one plain segment with no tokens and no ranges", () => {
    const { segments } = joined("plain text", null, null)
    expect(segments).toEqual([{ text: "plain text", cls: "", hit: false }])
  })

  it("emits one segment per token with no ranges", () => {
    const text = '{"a":1}'
    const tokens = tokenizeJsonLine(text)!
    const { segments, text: round } = joined(text, tokens, null)
    expect(round).toBe(text)
    expect(segments).toHaveLength(tokens.length)
    expect(segments.every((s) => !s.hit)).toBe(true)
    expect(segments.some((s) => s.cls !== "")).toBe(true)
  })

  it("splits a plain line around each hit", () => {
    const { segments, text } = joined("a hit b hit", null, q("hit"))
    expect(text).toBe("a hit b hit")
    expect(segments).toEqual([
      { text: "a ", cls: "", hit: false },
      { text: "hit", cls: "", hit: true },
      { text: " b ", cls: "", hit: false },
      { text: "hit", cls: "", hit: true },
    ])
  })

  it("keeps the text byte-identical when a hit spans token boundaries", () => {
    const text = '{"level":"error","msg":"x"}'
    const tokens = tokenizeJsonLine(text)!
    // `":"` starts inside the key token, crosses the colon and ends inside the
    // value token.
    const { segments, text: round } = joined(text, tokens, q('":"'))
    expect(round).toBe(text)
    const hits = segments.filter((s) => s.hit)
    expect(hits.map((s) => s.text).join("")).toBe('":"":"')
    // Each hit fragment keeps the color of the token it came from.
    expect(hits.length).toBeGreaterThan(2)
    expect(new Set(hits.map((s) => s.cls)).size).toBeGreaterThan(1)
  })

  it("marks a hit that covers an entire token", () => {
    const text = '{"level":"error"}'
    const tokens = tokenizeJsonLine(text)!
    const { segments, text: round } = joined(text, tokens, q('"error"'))
    expect(round).toBe(text)
    const hit = segments.find((s) => s.hit)!
    expect(hit.text).toBe('"error"')
    expect(hit.cls).toContain("text-red-400")
  })

  it("marks a hit at the very start and end of a line", () => {
    const { segments, text } = joined("hit", null, q("hit"))
    expect(text).toBe("hit")
    expect(segments).toEqual([{ text: "hit", cls: "", hit: true }])
  })
})
