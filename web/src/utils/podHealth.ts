// Classify a pod row from the Kubernetes Table API as healthy or problematic.
// Pure: it reads only the server printer's Status/Ready cells plus the row's
// object metadata, so it needs no per-kind knowledge beyond what `kubectl get
// pods` already prints, and it stays testable without a cluster.
//
// Three problem kinds, in the order they are worth looking at:
//   error     — the status itself is a failure (CrashLoopBackOff, Error,
//               ImagePullBackOff, Evicted, OOMKilled, Init:Error, Unknown, ...)
//   not-ready — Running, but not all containers pass their readiness probe
//   stuck     — a normal transitional status (Pending, ContainerCreating,
//               PodInitializing, Init:0/2, Terminating) that has outlasted
//               STUCK_GRACE_MS (15m)
//
// The grace period is what keeps the card quiet during a rollout: pods are
// briefly Pending/ContainerCreating/not-ready by design, and only a pod that
// stays there is a problem. It applies to `not-ready` too (readiness probes
// have warm-up periods) — but off the pod's own age, so a long-running pod
// that goes unready is reported immediately.
//
// A **terminal** failure (Evicted, Error, OOMKilled, DeadlineExceeded, ...) is
// a pod that has already finished and will never change again. Those are worth
// reporting while they are news and are pure noise afterwards — a handful of
// Evicted leftovers or the pods a CronJob's failedJobsHistoryLimit retains
// would otherwise keep the card on screen permanently, which is exactly the
// alert fatigue the grace above avoids for the other verdicts. They therefore
// drop off after TERMINAL_MAX_AGE_MS. A *recurring* failure never does:
// CrashLoopBackOff, ImagePullBackOff and friends are the kubelet still trying,
// and stay listed for as long as they last.

import type { K8sTableColumn, K8sTableRow } from "@/api/types"
import { scalarCellText } from "@/utils/tableCells"

export type PodProblem = "error" | "not-ready" | "stuck"

/**
 * How long a transitional status may last before it counts as stuck. Long
 * enough to cover an image pull on a cold node and a slow rollout — the card
 * exists to report what is not going to resolve itself.
 */
export const STUCK_GRACE_MS = 15 * 60 * 1000

/**
 * How long a pod that has already failed for good stays reported. Measured
 * from the last write to its status (see statusAgeMs), not from its creation:
 * an eviction hits pods that have been running for weeks, and their age says
 * nothing about when they died.
 */
export const TERMINAL_MAX_AGE_MS = 6 * 60 * 60 * 1000

/** Display order: the worst first. */
export const PROBLEM_RANK: Record<PodProblem, number> = {
  error: 0,
  "not-ready": 1,
  stuck: 2,
}

/** Statuses that are fine on their own (Running is additionally Ready-checked). */
const HEALTHY_STATUSES = new Set(["running", "completed", "succeeded"])

/** Normal transitional statuses — a problem only once they outlast the grace. */
const TRANSIENT_STATUSES = new Set([
  "pending",
  "containercreating",
  "podinitializing",
  "terminating",
])

/** `Init:0/2` — init containers making progress. `Init:Error` etc. are errors. */
const INIT_PROGRESS_RE = /^init:\d+\/\d+$/

/**
 * Failures with nothing left to retry: the pod is finished and only deletion
 * will change it. Anything else in the failure tier (CrashLoopBackOff,
 * ImagePullBackOff, CreateContainerConfigError, Init:Error, ...) is the kubelet
 * still working on it and is never aged out.
 */
const TERMINAL_STATUSES = new Set([
  "error",
  "failed",
  "evicted",
  "oomkilled",
  "deadlineexceeded",
  "nodeaffinity",
  "nodelost",
  "shutdown",
  "terminated",
  "containerstatusunknown",
  "unexpectedadmissionerror",
])

/** `OutOfcpu`, `OutOfmemory`, `OutOfpods` — admission rejections, also terminal. */
const OUT_OF_PREFIX = "outof"

export interface PodColumnIndexes {
  status: number
  ready: number
}

/** Locate the printer's Status/Ready columns (-1 when the server omits one). */
export function podColumnIndexes(defs: K8sTableColumn[]): PodColumnIndexes {
  const find = (name: string): number =>
    defs.findIndex((d) => d.name.toLowerCase() === name)
  return { status: find("status"), ready: find("ready") }
}

/** scalarCellText, not cellText: an unclassifiable cell must read as absent. */
function cellAt(row: K8sTableRow, index: number): string {
  return index < 0 ? "" : scalarCellText(row.cells[index])
}

/** "1/2" → not every container is ready. Anything unparseable → false. */
function readyMismatch(text: string): boolean {
  const m = /^(\d+)\/(\d+)$/.exec(text.trim())
  return m !== null && Number(m[1]) < Number(m[2])
}

/**
 * Age of the current state: since deletion for a pod being deleted (the one
 * whose status reads Terminating), since creation otherwise. A missing or
 * unparseable timestamp counts as old, so an unclassifiable pod is surfaced
 * rather than silently hidden.
 */
function stateAgeMs(row: K8sTableRow, nowMs: number): number {
  const meta = row.object?.metadata
  const stamp = meta?.deletionTimestamp ?? meta?.creationTimestamp
  const started = stamp === undefined ? NaN : Date.parse(stamp)
  return Number.isNaN(started) ? Number.POSITIVE_INFINITY : nowMs - started
}

/**
 * How long ago the pod's status was last written, or null when that cannot be
 * told. The kubelet owns `status`, so its managedFields entry timestamps the
 * last state change — the only clock in a Table row that says *when the pod
 * failed*, as opposed to when it was created. Unknowable (managedFields
 * stripped, no status writer yet, unparseable time) is deliberately null and
 * not a number: the single caller ages pods **out** of the report, so no
 * answer must mean "keep showing it".
 */
function statusAgeMs(row: K8sTableRow, nowMs: number): number | null {
  const entries = row.object?.metadata?.managedFields
  if (!Array.isArray(entries)) return null
  let latest = Number.NEGATIVE_INFINITY
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) continue
    const entry = raw as { subresource?: unknown; time?: unknown }
    if (entry.subresource !== "status" || typeof entry.time !== "string") continue
    const written = Date.parse(entry.time)
    if (!Number.isNaN(written) && written > latest) latest = written
  }
  return latest === Number.NEGATIVE_INFINITY ? null : nowMs - latest
}

/**
 * The pod's problem, or null when it is healthy (or when the server printed no
 * Status column — the List→Table fallback — where there is nothing to judge).
 */
export function podProblem(
  row: K8sTableRow,
  cols: PodColumnIndexes,
  nowMs: number,
): PodProblem | null {
  const status = cellAt(row, cols.status).trim().toLowerCase()
  if (status === "") return null

  if (TRANSIENT_STATUSES.has(status) || INIT_PROGRESS_RE.test(status)) {
    return stateAgeMs(row, nowMs) >= STUCK_GRACE_MS ? "stuck" : null
  }
  if (HEALTHY_STATUSES.has(status)) {
    // Completed/Succeeded pods legitimately report Ready 0/1.
    if (status !== "running") return null
    if (!readyMismatch(cellAt(row, cols.ready))) return null
    return stateAgeMs(row, nowMs) >= STUCK_GRACE_MS ? "not-ready" : null
  }
  if (TERMINAL_STATUSES.has(status) || status.startsWith(OUT_OF_PREFIX)) {
    const since = statusAgeMs(row, nowMs)
    // Unknowable age keeps it listed: hiding is the destructive answer here.
    return since !== null && since >= TERMINAL_MAX_AGE_MS ? null : "error"
  }
  return "error"
}
