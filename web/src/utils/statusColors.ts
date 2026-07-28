// Color-coding for well-known status values in table cells.

const ERROR_STATUSES = new Set([
  "failed",
  "error",
  "evicted",
  "oomkilled",
  "notready",
  "unknown",
  "invalid",
])

// Init:CrashLoopBackOff, ErrImagePull, FailedMount, FailedScheduling, ...
const ERROR_SUBSTRINGS = ["crashloopbackoff", "backoff", "errimage", "error", "fail", "unhealthy"]

const WARNING_STATUSES = new Set([
  "pending",
  "terminating",
  "containercreating",
  "podinitializing",
  "schedulingdisabled",
  "unschedulable",
  "progressing",
  "warning", // event Type column
])

// Columns whose values are statuses and deserve color-coding. Name,
// Selector, Images etc. must never be colored even when they contain words
// like "error".
const STATUS_COLUMN_RE = /status|state|reason|type|phase|condition|health|ready/i

export function isStatusColumn(columnName: string): boolean {
  return STATUS_COLUMN_RE.test(columnName)
}

// Columns holding a boolean whose "True" is the notable state: a CronJob's
// SUSPEND column ("True" = the schedule fires no jobs), and the `suspend` field
// of a CronJob/Job spec in the field tree. "False" is the ordinary state and
// stays neutral. This is a *kind* of its own rather than "true" added to
// WARNING_STATUSES because every other status column has the opposite polarity
// — a field tree's `ready: true` is healthy, not a warning — and the value
// alone cannot tell the two apart.
const WARN_WHEN_TRUE_COLUMN_RE = /^\s*suspend(ed)?\s*$/i

/** How a column's cells are read: as status words, or as an inverted boolean. */
export type StatusColumnKind = "status" | "warn-when-true"

/**
 * The rule a column's cells are classified by, or null when its values are not
 * statuses at all. Resolved from the column name alone, so callers on a hot path
 * (ResourceTable, once per column set) can keep the answer instead of asking per
 * cell.
 */
export function statusColumnKind(columnName: string): StatusColumnKind | null {
  if (WARN_WHEN_TRUE_COLUMN_RE.test(columnName)) return "warn-when-true"
  return isStatusColumn(columnName) ? "status" : null
}

/** How alarming a status value reads. */
export type StatusSeverity = "error" | "warning"

/**
 * The severity a cell value reads as, or null for neutral values. This is the
 * classification itself, so callers that need something other than a text color
 * (eventRowClass tints whole rows) derive it from the severity rather than
 * searching a class string for a palette name — which made repainting the error
 * palette silently change what counts as an error.
 *
 * kubectl's Node printer emits STATUS as a comma-joined condition list
 * ("NotReady,SchedulingDisabled"), so the value is classified by its parts and
 * the worst severity wins — matching only the whole cell would render a
 * cordoned NotReady node exactly like a healthy one.
 */
export function statusSeverity(value: string): StatusSeverity | null {
  let warning = false
  for (const part of value.split(",")) {
    const v = part.trim().toLowerCase()
    if (v === "") continue
    if (ERROR_STATUSES.has(v) || ERROR_SUBSTRINGS.some((s) => v.includes(s))) {
      return "error"
    }
    if (WARNING_STATUSES.has(v)) warning = true
  }
  return warning ? "warning" : null
}

// One complete class string per severity: a static text color beside a
// conditional one lets stylesheet order pick the winner, not class order.
const SEVERITY_TEXT_CLASS: Record<StatusSeverity, string> = {
  error: "text-red-600 dark:text-red-400 font-medium",
  warning: "text-amber-600 dark:text-amber-400",
}

/**
 * The neutral cell color, for the same reason the severity classes above are
 * whole strings: it must be baked into the one expression that resolves a cell's
 * color rather than sit on the element as a static utility beside a conditional
 * one. Exported so the tables that need to complete `statusTextClass`'s nullable
 * answer (ResourceTable, ResourceMiniTable, ObjectFieldTree) all spell "neutral"
 * the same way — three inlined copies of this literal is how a repaint of the
 * palette would silently leave some views behind.
 */
export const NEUTRAL_TEXT_CLASS = "text-slate-700 dark:text-slate-300"

/**
 * Returns a text color class for a cell value when it looks like an error or
 * warning status, or null for neutral values — the color mapping of
 * statusSeverity above.
 */
export function statusTextClass(value: string): string | null {
  const severity = statusSeverity(value)
  return severity === null ? null : SEVERITY_TEXT_CLASS[severity]
}

/** "True" (however cased) is the notable state; anything else is neutral. */
function warnWhenTrueSeverity(value: string): StatusSeverity | null {
  return value.trim().toLowerCase() === "true" ? "warning" : null
}

/**
 * The text color class for a cell of a column already classified by
 * `statusColumnKind`, or null for neutral values. Split from `statusTextClass`
 * because the polarity of a boolean column is a property of the column, not of
 * the value.
 */
export function cellTextClass(kind: StatusColumnKind, value: string): string | null {
  const severity = kind === "warn-when-true" ? warnWhenTrueSeverity(value) : statusSeverity(value)
  return severity === null ? null : SEVERITY_TEXT_CLASS[severity]
}
