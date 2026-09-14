import { describe, expect, it } from "vitest"

import type { K8sObject, K8sTable } from "@/api/types"
import { defaultPodName, ownedBy, podChoices, podOwnerSpec } from "@/utils/ownedPods"

function obj(apiVersion: string, kind: string): K8sObject {
  return { apiVersion, kind, metadata: { name: "x" } }
}

function podRow(name: string, status: string | null, createdAt?: string, uid = `uid-${name}`) {
  return {
    cells: [name, "1/1", status, 0, "1d"],
    object: { metadata: { name, uid, namespace: "ns", creationTimestamp: createdAt } },
  }
}

const COLUMNS: K8sTable["columnDefinitions"] = [
  { name: "Name", type: "string" },
  { name: "Ready", type: "string" },
  { name: "Status", type: "string" },
  { name: "Restarts", type: "integer" },
  { name: "Age", type: "string" },
]

function table(rows: K8sTable["rows"], columnDefinitions = COLUMNS): K8sTable {
  return { kind: "Table", columnDefinitions, rows }
}

describe("podOwnerSpec", () => {
  it("knows the six pod-owning kinds", () => {
    expect(podOwnerSpec(obj("apps/v1", "Deployment"))).toEqual({ mode: "deployment" })
    expect(podOwnerSpec(obj("apps/v1", "ReplicaSet"))?.mode).toBe("owner")
    expect(podOwnerSpec(obj("apps/v1", "StatefulSet"))?.mode).toBe("owner")
    expect(podOwnerSpec(obj("apps/v1", "DaemonSet"))?.mode).toBe("owner")
    expect(podOwnerSpec(obj("batch/v1", "Job"))?.mode).toBe("owner")
    expect(podOwnerSpec(obj("v1", "Service"))).toEqual({ mode: "service" })
  })

  // Pod has its own Logs tab; CronJob owns Jobs, not pods (owner decision:
  // many Jobs, logs one click away); Node lists pods but owns none.
  it("returns undefined for kinds that do not own pods", () => {
    expect(podOwnerSpec(obj("v1", "Pod"))).toBeUndefined()
    expect(podOwnerSpec(obj("batch/v1", "CronJob"))).toBeUndefined()
    expect(podOwnerSpec(obj("v1", "Node"))).toBeUndefined()
    expect(podOwnerSpec({ kind: "Deployment" })).toBeUndefined() // no apiVersion
  })
})

describe("podChoices", () => {
  it("orders newest first, ties by name, unparseable dates last", () => {
    const choices = podChoices(
      table([
        podRow("old", "Running", "2026-01-01T00:00:00Z"),
        podRow("b-new", "Running", "2026-03-01T00:00:00Z"),
        podRow("a-new", "Pending", "2026-03-01T00:00:00Z"),
        podRow("undated", "Running"),
        podRow("garbage", "Running", "not-a-date"),
      ]),
    )
    expect(choices.map((c) => c.name)).toEqual(["a-new", "b-new", "old", "garbage", "undated"])
    expect(choices[0]).toEqual({
      name: "a-new",
      status: "Pending",
      createdMs: Date.parse("2026-03-01T00:00:00Z"),
    })
  })

  // The List→Table fallback prints no Status column; a non-scalar cell is
  // unclassifiable and reads as absent, like podHealth.
  it("reads status as empty without a Status column and drops nameless rows", () => {
    const noStatus = table(
      [
        { cells: ["p", "1d"], object: { metadata: { name: "p", uid: "u" } } },
        { cells: ["", "1d"], object: { metadata: { uid: "anon" } } },
      ],
      [
        { name: "Name", type: "string" },
        { name: "Age", type: "string" },
      ],
    )
    expect(podChoices(noStatus)).toEqual([
      { name: "p", status: "", createdMs: Number.NEGATIVE_INFINITY },
    ])
    expect(podChoices({ kind: "Table", columnDefinitions: COLUMNS })).toEqual([])
  })
})

describe("ownedBy", () => {
  it("matches any owner reference carrying the uid", () => {
    const owns = ownedBy("u1")
    expect(owns({ ownerReferences: [{ apiVersion: "v1", kind: "X", name: "x", uid: "u1" }] })).toBe(true)
    expect(
      owns({
        ownerReferences: [
          { apiVersion: "v1", kind: "X", name: "x", uid: "other" },
          { apiVersion: "v1", kind: "Y", name: "y", uid: "u1" },
        ],
      }),
    ).toBe(true)
    expect(owns({ ownerReferences: [{ apiVersion: "v1", kind: "X", name: "x", uid: "u2" }] })).toBe(false)
    expect(owns({})).toBe(false)
  })
})

describe("defaultPodName", () => {
  it("picks the newest Running pod", () => {
    const choices = podChoices(
      table([
        podRow("newest-crashing", "CrashLoopBackOff", "2026-03-02T00:00:00Z"),
        podRow("running-newer", "Running", "2026-03-01T00:00:00Z"),
        podRow("running-older", "running", "2026-02-01T00:00:00Z"),
      ]),
    )
    expect(defaultPodName(choices)).toBe("running-newer")
  })

  it("falls back to the newest pod when none is Running", () => {
    const choices = podChoices(
      table([
        podRow("older", "Completed", "2026-02-01T00:00:00Z"),
        podRow("newer", "Error", "2026-03-01T00:00:00Z"),
      ]),
    )
    expect(defaultPodName(choices)).toBe("newer")
  })

  it("falls back to the newest pod without a Status column", () => {
    const choices = podChoices(
      table(
        [
          { cells: ["older"], object: { metadata: { name: "older", creationTimestamp: "2026-02-01T00:00:00Z" } } },
          { cells: ["newer"], object: { metadata: { name: "newer", creationTimestamp: "2026-03-01T00:00:00Z" } } },
        ],
        [{ name: "Name", type: "string" }],
      ),
    )
    expect(defaultPodName(choices)).toBe("newer")
  })

  it("is empty for no choices", () => {
    expect(defaultPodName([])).toBe("")
  })
})
