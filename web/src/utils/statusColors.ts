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

/**
 * Returns a text color class for a cell value when it looks like an error or
 * warning status, or null for neutral values.
 */
export function statusTextClass(value: string): string | null {
  const v = value.trim().toLowerCase()
  if (v === "") return null
  if (ERROR_STATUSES.has(v) || ERROR_SUBSTRINGS.some((s) => v.includes(s))) {
    return "text-red-600 dark:text-red-400 font-medium"
  }
  if (WARNING_STATUSES.has(v)) return "text-amber-600 dark:text-amber-400"
  return null
}
