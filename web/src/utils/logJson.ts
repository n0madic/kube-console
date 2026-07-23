// Colorizing of JSON-lines log output.
//
// Structured loggers emit one JSON object per line, so a log stream is JSONL,
// not a JSON document — every line is scanned on its own and a line that is
// not a complete JSON object is left alone (`null`) and rendered as plain text.
//
// The scanner walks the raw text and emits the **original substrings**: the
// concatenation of all token texts is always byte-identical to the input line.
// Re-serializing through JSON.parse would have been shorter but would rewrite
// what the container actually logged — int64 ids past 2^53 would silently
// change digits, 1.0 would become 1, and key order with numeric-looking keys
// would shuffle.

export type LogTokenKind = "text" | "punct" | "key" | "string" | "number" | "keyword" | "level"

export type LogSeverity = "error" | "warn" | "info" | "debug"

export interface LogToken {
  kind: LogTokenKind
  text: string
  severity?: LogSeverity
}

// `timestamps=true` prefixes each line with an RFC3339 stamp from the kubelet,
// which would otherwise make every line unparsable. The pattern is deliberately
// narrow so that arbitrary text before a JSON blob does not get dimmed.
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\S*\s+/

const LEVEL_KEYS = new Set(["level", "severity", "lvl", "loglevel", "log.level"])

// Sticky: matched at the current position without slicing the line.
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y

function severityOfName(value: string): LogSeverity | undefined {
  const s = value.toLowerCase()
  if (
    s.startsWith("err") ||
    s.startsWith("fatal") ||
    s.startsWith("crit") ||
    s.startsWith("panic") ||
    s.startsWith("alert") ||
    s.startsWith("emerg")
  ) {
    return "error"
  }
  if (s.startsWith("warn")) return "warn"
  if (s.startsWith("info") || s.startsWith("notice")) return "info"
  if (s.startsWith("debug") || s.startsWith("trace")) return "debug"
  return undefined
}

// pino/bunyan write the level as a number on the same key.
function severityOfNumber(value: string): LogSeverity | undefined {
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  if (n >= 50) return "error"
  if (n >= 40) return "warn"
  if (n >= 30) return "info"
  if (n >= 10) return "debug"
  return undefined
}

/**
 * Splits a JSON-object log line into colorizable tokens, or returns null when
 * the line is not one (plain text, a fragment, trailing garbage).
 */
export function tokenizeJsonLine(line: string): LogToken[] | null {
  const prefix = TIMESTAMP_PREFIX.exec(line)?.[0] ?? ""
  const src = prefix === "" ? line : line.slice(prefix.length)
  // Cheap reject first: the vast majority of lines never start an object.
  if (src.charAt(0) !== "{") return null

  const tokens: LogToken[] = []
  if (prefix !== "") tokens.push({ kind: "text", text: prefix })
  let pos = 0

  function whitespace(): void {
    const start = pos
    while (pos < src.length && (src[pos] === " " || src[pos] === "\t")) pos++
    if (pos > start) tokens.push({ kind: "punct", text: src.slice(start, pos) })
  }

  function punct(ch: string): boolean {
    if (src[pos] !== ch) return false
    tokens.push({ kind: "punct", text: ch })
    pos++
    return true
  }

  // Returns the raw literal including its quotes, so it can be emitted verbatim.
  function stringLiteral(): string | null {
    if (src[pos] !== '"') return null
    let p = pos + 1
    for (;;) {
      if (p >= src.length) return null
      const c = src[p]
      if (c === "\\") {
        p += 2
        continue
      }
      if (c === '"') break
      p++
    }
    const raw = src.slice(pos, p + 1)
    pos = p + 1
    return raw
  }

  function value(isLevel: boolean): boolean {
    whitespace()
    const c = src[pos]
    if (c === undefined) return false
    if (c === "{") return object()
    if (c === "[") return array()
    if (c === '"') {
      const raw = stringLiteral()
      if (raw === null) return false
      // Escapes inside a level value are pathological; comparing the raw
      // inner text avoids a JSON.parse per string.
      const severity = isLevel ? severityOfName(raw.slice(1, -1)) : undefined
      tokens.push(
        severity === undefined ? { kind: "string", text: raw } : { kind: "level", text: raw, severity },
      )
      return true
    }
    for (const word of ["true", "false", "null"]) {
      if (src.startsWith(word, pos)) {
        tokens.push({ kind: "keyword", text: word })
        pos += word.length
        return true
      }
    }
    NUMBER.lastIndex = pos
    const matched = NUMBER.exec(src)
    if (matched === null) return false
    const text = matched[0]
    const severity = isLevel ? severityOfNumber(text) : undefined
    tokens.push(
      severity === undefined ? { kind: "number", text } : { kind: "level", text, severity },
    )
    pos += text.length
    return true
  }

  function object(): boolean {
    if (!punct("{")) return false
    whitespace()
    if (punct("}")) return true
    for (;;) {
      whitespace()
      const key = stringLiteral()
      if (key === null) return false
      tokens.push({ kind: "key", text: key })
      const isLevel = LEVEL_KEYS.has(key.slice(1, -1).toLowerCase())
      whitespace()
      if (!punct(":")) return false
      if (!value(isLevel)) return false
      whitespace()
      if (punct(",")) continue
      return punct("}")
    }
  }

  function array(): boolean {
    if (!punct("[")) return false
    whitespace()
    if (punct("]")) return true
    for (;;) {
      if (!value(false)) return false
      whitespace()
      if (punct(",")) continue
      return punct("]")
    }
  }

  if (!object()) return null
  whitespace()
  // Anything after the closing brace means this was not a log record.
  if (pos !== src.length) return null
  return tokens
}

// Tailwind: the full color class comes from one expression per token, never a
// static text-* utility plus a conditional one (stylesheet order would decide
// the winner). Severity is carried by weight as well as hue, so a level value
// stays distinguishable from a same-colored ordinary value.
const SEVERITY_CLASS: Record<LogSeverity, string> = {
  error: "font-bold text-red-400",
  warn: "font-bold text-yellow-300",
  info: "font-bold text-emerald-300",
  debug: "font-bold text-slate-400",
}

const KIND_CLASS: Record<LogTokenKind, string> = {
  text: "text-slate-500",
  punct: "text-slate-500",
  key: "text-sky-300",
  string: "text-emerald-300",
  number: "text-amber-300",
  keyword: "text-fuchsia-300",
  // Only reachable for a level token whose severity was not recognized, which
  // the scanner does not emit; kept so the map stays total.
  level: "text-emerald-300",
}

export function logTokenClass(token: LogToken): string {
  if (token.severity !== undefined) return SEVERITY_CLASS[token.severity]
  return KIND_CLASS[token.kind]
}
