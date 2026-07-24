import { describe, expect, it } from "vitest"

import type { K8sTableColumn, K8sTableRow } from "@/api/types"
import {
  podColumnIndexes,
  podProblem,
  PROBLEM_RANK,
  STUCK_GRACE_MS,
  TERMINAL_MAX_AGE_MS,
} from "@/utils/podHealth"

// The pod printer's default columns (kubectl get pods).
const DEFS: K8sTableColumn[] = [
  { name: "Name", type: "string" },
  { name: "Ready", type: "string" },
  { name: "Status", type: "string" },
  { name: "Restarts", type: "string" },
  { name: "Age", type: "string" },
]

const COLS = podColumnIndexes(DEFS)
const NOW = Date.parse("2026-07-24T12:00:00Z")

function agoIso(ms: number): string {
  return new Date(NOW - ms).toISOString()
}

interface RowOptions {
  ready?: string
  ageMs?: number
  deletedAgoMs?: number
  timestamp?: string | undefined
  /** How long ago the kubelet last wrote status (omitted → no managedFields). */
  statusWrittenAgoMs?: number
}

function row(status: string, opts: RowOptions = {}): K8sTableRow {
  const meta: Record<string, unknown> = { name: "pod-a", namespace: "default" }
  if (!("timestamp" in opts)) meta.creationTimestamp = agoIso(opts.ageMs ?? 0)
  else if (opts.timestamp !== undefined) meta.creationTimestamp = opts.timestamp
  if (opts.deletedAgoMs !== undefined) meta.deletionTimestamp = agoIso(opts.deletedAgoMs)
  if (opts.statusWrittenAgoMs !== undefined) {
    meta.managedFields = [
      // The spec writer, with no subresource: never the status clock.
      { manager: "kube-controller-manager", operation: "Update", time: agoIso(opts.ageMs ?? 0) },
      {
        manager: "kubelet",
        operation: "Update",
        subresource: "status",
        time: agoIso(opts.statusWrittenAgoMs),
      },
    ]
  }
  return {
    cells: ["pod-a", opts.ready ?? "1/1", status, "0", "1h"],
    object: { metadata: meta },
  }
}

describe("podColumnIndexes", () => {
  it("locates Status and Ready case-insensitively", () => {
    expect(podColumnIndexes(DEFS)).toEqual({ status: 2, ready: 1 })
  })

  it("reports -1 for columns the server did not print", () => {
    expect(podColumnIndexes([{ name: "Name", type: "string" }])).toEqual({
      status: -1,
      ready: -1,
    })
  })
})

describe("podProblem", () => {
  it("treats healthy pods as no problem", () => {
    expect(podProblem(row("Running", { ready: "2/2" }), COLS, NOW)).toBeNull()
    expect(podProblem(row("Completed", { ready: "0/1" }), COLS, NOW)).toBeNull()
    expect(podProblem(row("Succeeded", { ready: "0/1" }), COLS, NOW)).toBeNull()
  })

  it("flags failure statuses immediately, however young the pod", () => {
    for (const status of [
      "CrashLoopBackOff",
      "Error",
      "ImagePullBackOff",
      "ErrImagePull",
      "Evicted",
      "OOMKilled",
      "CreateContainerConfigError",
      "Init:CrashLoopBackOff",
      "Init:Error",
      "Unknown",
      "Failed",
    ]) {
      expect(podProblem(row(status, { ready: "0/1", ageMs: 1000 }), COLS, NOW)).toBe("error")
    }
  })

  it("flags Running pods whose containers are not all ready, past the grace", () => {
    expect(
      podProblem(row("Running", { ready: "1/2", ageMs: STUCK_GRACE_MS + 1000 }), COLS, NOW),
    ).toBe("not-ready")
  })

  it("gives a freshly started pod time to become ready", () => {
    expect(podProblem(row("Running", { ready: "0/1", ageMs: 30_000 }), COLS, NOW)).toBeNull()
  })

  // Pins the grace itself: every other case here is written relative to the
  // constant and would follow it silently wherever it moved.
  it("keeps a 15-minute grace", () => {
    expect(STUCK_GRACE_MS).toBe(15 * 60 * 1000)
    expect(podProblem(row("Pending", { ready: "0/1", ageMs: 10 * 60 * 1000 }), COLS, NOW)).toBeNull()
  })

  it("ignores transitional statuses within the grace period", () => {
    for (const status of ["Pending", "ContainerCreating", "PodInitializing", "Init:0/2"]) {
      expect(podProblem(row(status, { ready: "0/1", ageMs: 30_000 }), COLS, NOW)).toBeNull()
    }
  })

  it("flags transitional statuses that outlast the grace period", () => {
    for (const status of ["Pending", "ContainerCreating", "PodInitializing", "Init:0/2"]) {
      expect(
        podProblem(row(status, { ready: "0/1", ageMs: STUCK_GRACE_MS + 1000 }), COLS, NOW),
      ).toBe("stuck")
    }
  })

  it("measures a Terminating pod from its deletion, not its creation", () => {
    // Deleted seconds ago: normal teardown, however old the pod itself is.
    expect(
      podProblem(
        row("Terminating", { ageMs: 30 * 24 * 3600 * 1000, deletedAgoMs: 5_000 }),
        COLS,
        NOW,
      ),
    ).toBeNull()
    expect(
      podProblem(
        row("Terminating", {
          ageMs: 30 * 24 * 3600 * 1000,
          deletedAgoMs: STUCK_GRACE_MS + 1000,
        }),
        COLS,
        NOW,
      ),
    ).toBe("stuck")
  })

  it("surfaces a transitional pod with no usable timestamp instead of hiding it", () => {
    expect(podProblem(row("Pending", { timestamp: undefined }), COLS, NOW)).toBe("stuck")
    expect(podProblem(row("Pending", { timestamp: "not-a-date" }), COLS, NOW)).toBe("stuck")
  })

  it("judges nothing when the server printed no Status column", () => {
    const noStatus = podColumnIndexes([{ name: "Name", type: "string" }])
    expect(podProblem(row("CrashLoopBackOff"), noStatus, NOW)).toBeNull()
  })

  it("ignores an unparseable Ready cell on a Running pod", () => {
    expect(
      podProblem(row("Running", { ready: "<none>", ageMs: STUCK_GRACE_MS + 1000 }), COLS, NOW),
    ).toBeNull()
  })

  it("drops terminal failures once they are old news", () => {
    for (const status of ["Evicted", "Error", "OOMKilled", "DeadlineExceeded", "OutOfmemory"]) {
      expect(
        podProblem(
          row(status, { ready: "0/1", statusWrittenAgoMs: TERMINAL_MAX_AGE_MS + 60_000 }),
          COLS,
          NOW,
        ),
      ).toBeNull()
    }
  })

  it("reports a fresh eviction however old the pod itself is", () => {
    // The case a creation-age bound gets wrong: eviction hits pods that have
    // been running for weeks, so only the status write dates the failure.
    expect(
      podProblem(
        row("Evicted", {
          ready: "0/1",
          ageMs: 30 * 24 * 3600 * 1000,
          statusWrittenAgoMs: 2 * 60 * 1000,
        }),
        COLS,
        NOW,
      ),
    ).toBe("error")
  })

  it("never ages out a failure the kubelet is still retrying", () => {
    for (const status of ["CrashLoopBackOff", "ImagePullBackOff", "CreateContainerConfigError"]) {
      expect(
        podProblem(
          row(status, { ready: "0/1", statusWrittenAgoMs: 30 * 24 * 3600 * 1000 }),
          COLS,
          NOW,
        ),
      ).toBe("error")
    }
  })

  it("keeps a terminal pod whose status write cannot be dated", () => {
    // No managedFields (stripped by a proxy, or an old apiserver): hiding is
    // the destructive answer, so the pod stays listed.
    expect(podProblem(row("Evicted", { ready: "0/1", ageMs: 30 * 24 * 3600 * 1000 }), COLS, NOW)).toBe(
      "error",
    )
  })

  it("keeps terminal failures for 6 hours", () => {
    expect(TERMINAL_MAX_AGE_MS).toBe(6 * 60 * 60 * 1000)
    expect(
      podProblem(row("Evicted", { ready: "0/1", statusWrittenAgoMs: 5 * 3600 * 1000 }), COLS, NOW),
    ).toBe("error")
  })

  it("ranks errors before not-ready before stuck", () => {
    expect(PROBLEM_RANK.error).toBeLessThan(PROBLEM_RANK["not-ready"])
    expect(PROBLEM_RANK["not-ready"]).toBeLessThan(PROBLEM_RANK.stuck)
  })
})
