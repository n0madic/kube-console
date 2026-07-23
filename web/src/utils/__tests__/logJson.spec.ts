import { describe, expect, it } from "vitest"

import { logTokenClass, tokenizeJsonLine, type LogToken } from "@/utils/logJson"

function kindOf(tokens: LogToken[], text: string): string | undefined {
  return tokens.find((t) => t.text === text)?.kind
}

function severityOf(tokens: LogToken[], text: string): string | undefined {
  return tokens.find((t) => t.text === text)?.severity
}

describe("tokenizeJsonLine", () => {
  it("leaves non-JSON lines alone", () => {
    expect(tokenizeJsonLine("2026-07-21 starting server on :8080")).toBeNull()
    expect(tokenizeJsonLine("")).toBeNull()
    expect(tokenizeJsonLine("[GIN] 200 | GET /healthz")).toBeNull()
  })

  it("rejects fragments and trailing garbage", () => {
    expect(tokenizeJsonLine('{"a":1')).toBeNull()
    expect(tokenizeJsonLine('{"a":1} trailing')).toBeNull()
    expect(tokenizeJsonLine('{"a":}')).toBeNull()
  })

  it("classifies keys and value types", () => {
    const tokens = tokenizeJsonLine('{"msg":"ok","n":1.5,"ok":true,"e":null,"a":[1,"x"],"o":{"k":2}}')
    expect(tokens).not.toBeNull()
    const t = tokens as LogToken[]
    expect(kindOf(t, '"msg"')).toBe("key")
    expect(kindOf(t, '"ok"')).toBe("string")
    expect(kindOf(t, "1.5")).toBe("number")
    expect(kindOf(t, "true")).toBe("keyword")
    expect(kindOf(t, "null")).toBe("keyword")
    expect(kindOf(t, '"x"')).toBe("string")
    expect(kindOf(t, "{")).toBe("punct")
  })

  // The whole point of scanning instead of re-serializing: what the container
  // logged is what gets rendered, digit for digit.
  it("reproduces the original line exactly", () => {
    const lines = [
      '{"id":12345678901234567890,"f":1.0,"e":1e3,"neg":-0.5}',
      '{ "spaced" : "value" , "arr" : [ 1 , 2 ] }',
      '{"msg":"quote \\" and backslash \\\\ and unicode \\u00e9"}',
      "{}",
      '{"empty":{},"none":[]}',
    ]
    for (const line of lines) {
      const tokens = tokenizeJsonLine(line)
      expect(tokens, line).not.toBeNull()
      expect((tokens as LogToken[]).map((t) => t.text).join("")).toBe(line)
    }
  })

  it("marks the severity of a level value", () => {
    const cases: Array<[string, string]> = [
      ["error", "error"],
      ["ERROR", "error"],
      ["fatal", "error"],
      ["panic", "error"],
      ["warning", "warn"],
      ["info", "info"],
      ["debug", "debug"],
      ["trace", "debug"],
    ]
    for (const [value, severity] of cases) {
      const tokens = tokenizeJsonLine(`{"level":"${value}"}`)
      expect(severityOf(tokens as LogToken[], `"${value}"`), value).toBe(severity)
    }
  })

  it("accepts the other level key spellings and numeric pino/bunyan levels", () => {
    expect(severityOf(tokenizeJsonLine('{"severity":"ERROR"}') as LogToken[], '"ERROR"')).toBe("error")
    expect(severityOf(tokenizeJsonLine('{"lvl":"warn"}') as LogToken[], '"warn"')).toBe("warn")
    expect(severityOf(tokenizeJsonLine('{"level":50}') as LogToken[], "50")).toBe("error")
    expect(severityOf(tokenizeJsonLine('{"level":40}') as LogToken[], "40")).toBe("warn")
    expect(severityOf(tokenizeJsonLine('{"level":30}') as LogToken[], "30")).toBe("info")
    expect(severityOf(tokenizeJsonLine('{"level":20}') as LogToken[], "20")).toBe("debug")
  })

  it("does not colorize a level-looking value under another key", () => {
    const tokens = tokenizeJsonLine('{"msg":"error"}') as LogToken[]
    expect(kindOf(tokens, '"error"')).toBe("string")
    expect(severityOf(tokens, '"error"')).toBeUndefined()
  })

  it("keeps a kubelet timestamp prefix as its own token", () => {
    const line = '2026-07-21T10:00:01.123456789Z {"level":"info","msg":"ok"}'
    const tokens = tokenizeJsonLine(line) as LogToken[]
    expect(tokens).not.toBeNull()
    expect(tokens[0]?.kind).toBe("text")
    expect(tokens[0]?.text).toBe("2026-07-21T10:00:01.123456789Z ")
    expect(tokens.map((t) => t.text).join("")).toBe(line)
  })
})

describe("logTokenClass", () => {
  it("returns a single complete color class per token", () => {
    expect(logTokenClass({ kind: "key", text: '"a"' })).toBe("text-sky-300")
    expect(logTokenClass({ kind: "level", text: '"error"', severity: "error" })).toContain("text-red-400")
    // One expression, one text color — Tailwind order must not decide it.
    for (const kind of ["text", "punct", "key", "string", "number", "keyword"] as const) {
      expect(logTokenClass({ kind, text: "x" }).match(/text-/g)).toHaveLength(1)
    }
  })
})
