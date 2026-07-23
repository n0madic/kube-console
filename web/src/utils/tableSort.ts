// Value-aware comparison for Kubernetes Table cells: relative ages ("5m",
// "2m30s", "44d") and plain numbers sort numerically, everything else
// lexicographically.

const AGE_TOKEN = /(\d+)(ms|[smhdwy])/g

const AGE_MULTIPLIERS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  y: 31536000,
}

/** Parse a kubectl-style age ("44d", "2m30s") into seconds, or null. */
export function parseK8sAge(value: string): number | null {
  const s = value.trim()
  if (s === "") return null
  let total = 0
  let consumed = 0
  for (const match of s.matchAll(AGE_TOKEN)) {
    total += Number(match[1]) * (AGE_MULTIPLIERS[match[2] as string] ?? 0)
    consumed += match[0].length
  }
  return consumed === s.length && consumed > 0 ? total : null
}

const EMPTYISH = new Set(["", "<none>", "<unknown>", "<invalid>"])

/** Parse a plain finite number, or null ("" is not a number). */
function parseNumeric(value: string): number | null {
  if (value.trim() === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Compare two table cell strings: empty-ish values sort last, then numbers,
 * then ages, then locale string order.
 *
 * The comparator must be a total order (transitive) even when one column
 * mixes value shapes (e.g. RESTARTS cells "10" vs "3 (2m ago)"), so
 * mixed-shape pairs are ordered by shape rank instead of falling through to
 * localeCompare, which would break transitivity against the numeric branch.
 */
export function compareTableValues(a: string, b: string): number {
  const aEmpty = EMPTYISH.has(a.trim())
  const bEmpty = EMPTYISH.has(b.trim())
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1

  const aNum = parseNumeric(a)
  const bNum = parseNumeric(b)
  if (aNum !== null && bNum !== null) return aNum - bNum

  const aAge = aNum === null ? parseK8sAge(a) : null
  const bAge = bNum === null ? parseK8sAge(b) : null
  if (aAge !== null && bAge !== null) return aAge - bAge

  // Mixed shapes: numbers before ages before plain strings.
  const aRank = aNum !== null ? 0 : aAge !== null ? 1 : 2
  const bRank = bNum !== null ? 0 : bAge !== null ? 1 : 2
  if (aRank !== bRank) return aRank - bRank

  return a.localeCompare(b)
}
