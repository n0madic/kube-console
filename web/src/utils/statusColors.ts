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
 * Returns a text color class for a cell value when it looks like an error or
 * warning status, or null for neutral values — the color mapping of
 * statusSeverity above.
 */
export function statusTextClass(value: string): string | null {
  const severity = statusSeverity(value)
  return severity === null ? null : SEVERITY_TEXT_CLASS[severity]
}
