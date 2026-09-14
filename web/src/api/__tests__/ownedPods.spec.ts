import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/api/k8s", () => ({ listAllAsTable: vi.fn() }))

import { listAllAsTable } from "@/api/k8s"
import { resolveOwnedPods } from "@/api/ownedPods"
import type { K8sObject, K8sTable } from "@/api/types"

const mockedTable = vi.mocked(listAllAsTable)

// ReplicaSet rows carrying uids so the Deployment can resolve its grandchild pods.
const rsTable: K8sTable = {
  kind: "Table",
  columnDefinitions: [
    { name: "Name", type: "string" },
    { name: "Desired", type: "integer" },
    { name: "Age", type: "string" },
  ],
  rows: [
    {
      cells: ["web-abc", 3, "5d"],
      object: {
        metadata: {
          name: "web-abc",
          namespace: "prod",
          uid: "rs-1",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "dep-1" }],
        },
      },
    },
    {
      cells: ["web-old", 0, "20d"],
      object: {
        metadata: {
          name: "web-old",
          namespace: "prod",
          uid: "rs-other",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "other" }],
        },
      },
    },
  ],
}

const podsTable: K8sTable = {
  kind: "Table",
  columnDefinitions: [
    { name: "Name", type: "string" },
    { name: "Ready", type: "string" },
    { name: "Status", type: "string" },
    { name: "Restarts", type: "integer" },
    { name: "Age", type: "string" },
  ],
  rows: [
    {
      cells: ["web-abc-p1", "1/1", "Running", 0, "5d"],
      object: {
        metadata: {
          name: "web-abc-p1",
          namespace: "prod",
          uid: "pod-1",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-abc", uid: "rs-1" }],
        },
      },
    },
    {
      cells: ["foreign-p2", "1/1", "Running", 0, "5d"],
      object: {
        metadata: {
          name: "foreign-p2",
          namespace: "prod",
          uid: "pod-2",
          ownerReferences: [
            { apiVersion: "apps/v1", kind: "ReplicaSet", name: "other-xyz", uid: "rs-foreign" },
          ],
        },
      },
    },
    {
      cells: ["job-p3", "0/1", "Completed", 0, "1d"],
      object: {
        metadata: {
          name: "job-p3",
          namespace: "prod",
          uid: "pod-3",
          ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: "backup", uid: "job-1" }],
        },
      },
    },
  ],
}

const podsRef = { group: "", version: "v1", resource: "pods" }
const rsRef = { group: "apps", version: "v1", resource: "replicasets" }

function names(table: K8sTable | undefined): string[] {
  return (table?.rows ?? []).map((r) => r.object?.metadata?.name ?? "")
}

describe("resolveOwnedPods", () => {
  beforeEach(() => {
    mockedTable.mockReset()
  })

  const deployment: K8sObject = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace: "prod", uid: "dep-1" },
    spec: { selector: { matchLabels: { app: "web" } } },
  }

  it("walks a Deployment's ReplicaSets and their pods, excluding foreign ones", async () => {
    mockedTable
      .mockResolvedValueOnce({ table: rsTable, truncated: false })
      .mockResolvedValueOnce({ table: podsTable, truncated: true })

    const result = await resolveOwnedPods(deployment)

    // Two hops, both narrowed by the Deployment's own selector, in this order.
    expect(mockedTable).toHaveBeenNthCalledWith(
      1,
      rsRef,
      expect.objectContaining({ namespace: "prod", labelSelector: "app=web" }),
    )
    expect(mockedTable).toHaveBeenNthCalledWith(
      2,
      podsRef,
      expect.objectContaining({ namespace: "prod", labelSelector: "app=web" }),
    )
    expect(names(result?.pods)).toEqual(["web-abc-p1"])
    expect(result?.truncated).toBe(true)
    expect(result?.pods.columnDefinitions).toBe(podsTable.columnDefinitions)
    // The owned ReplicaSets ride along for the Related resources card.
    expect(names(result?.replicaSets?.table)).toEqual(["web-abc"])
    expect(result?.replicaSets?.truncated).toBe(false)
    expect(result?.selector).toBeUndefined()
  })

  // A ReplicaSet past the page cap contributes no uid to match against, so
  // its pods are silently filtered out — the picker has to say so.
  it("reports a truncated ReplicaSet walk as truncated pods", async () => {
    mockedTable
      .mockResolvedValueOnce({ table: rsTable, truncated: true })
      .mockResolvedValueOnce({ table: podsTable, truncated: false })
    const result = await resolveOwnedPods(deployment)
    expect(result?.truncated).toBe(true)
    expect(result?.replicaSets?.truncated).toBe(true)
  })

  it("resolves no pods for a Deployment owning no ReplicaSets", async () => {
    // Both walks are issued concurrently; the empty rsUids set drops every pod.
    mockedTable
      .mockResolvedValueOnce({ table: rsTable, truncated: false })
      .mockResolvedValueOnce({ table: podsTable, truncated: false })
    const result = await resolveOwnedPods({ ...deployment, metadata: { ...deployment.metadata, uid: "nobody" } })
    expect(mockedTable).toHaveBeenCalledTimes(2)
    expect(result?.pods.rows).toEqual([])
    expect(result?.replicaSets?.table.rows).toEqual([])
  })

  it("filters one-hop owners by ownerReferences.uid", async () => {
    mockedTable.mockResolvedValue({ table: podsTable, truncated: false })
    const job: K8sObject = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "backup", namespace: "prod", uid: "job-1" },
      spec: { selector: { matchLabels: { "controller-uid": "job-1" } } },
    }
    const result = await resolveOwnedPods(job)
    expect(mockedTable).toHaveBeenCalledTimes(1)
    expect(mockedTable).toHaveBeenCalledWith(
      podsRef,
      expect.objectContaining({ namespace: "prod", labelSelector: "controller-uid=job-1", maxPages: 6 }),
    )
    expect(names(result?.pods)).toEqual(["job-p3"])
    expect(result?.replicaSets).toBeUndefined()

    mockedTable.mockClear()
    const rs: K8sObject = {
      apiVersion: "apps/v1",
      kind: "ReplicaSet",
      metadata: { name: "web-abc", namespace: "prod", uid: "rs-1" },
      spec: {},
    }
    expect(names((await resolveOwnedPods(rs))?.pods)).toEqual(["web-abc-p1"])
    // No selector on the parent → no server-side narrowing.
    expect(mockedTable).toHaveBeenCalledWith(podsRef, expect.objectContaining({ labelSelector: undefined }))
  })

  it("matches a Service's pods by its selector, ownership ignored", async () => {
    mockedTable.mockResolvedValue({ table: podsTable, truncated: false })
    const service: K8sObject = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "web", namespace: "prod", uid: "svc-1" },
      spec: { selector: { app: "web", Tier: "Frontend" } },
    }
    const result = await resolveOwnedPods(service)
    expect(mockedTable).toHaveBeenCalledWith(
      podsRef,
      expect.objectContaining({ namespace: "prod", labelSelector: "app=web,Tier=Frontend", maxPages: 4 }),
    )
    expect(names(result?.pods)).toEqual(["web-abc-p1", "foreign-p2", "job-p3"])
    expect(result?.pods).toBe(podsTable) // handed through, not copied
    expect(result?.selector).toBe("app=web,Tier=Frontend")
  })

  it("resolves null for a Service without a selector", async () => {
    const headless: K8sObject = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "ext", namespace: "prod", uid: "svc-2" },
      spec: { type: "ExternalName" },
    }
    expect(await resolveOwnedPods(headless)).toBeNull()
    expect(await resolveOwnedPods({ ...headless, spec: { selector: {} } })).toBeNull()
    expect(mockedTable).not.toHaveBeenCalled()
  })

  it("resolves null for kinds outside the registry and for objects without a uid", async () => {
    expect(await resolveOwnedPods({ apiVersion: "v1", kind: "Pod", metadata: { name: "p", uid: "u" } })).toBeNull()
    expect(await resolveOwnedPods({ apiVersion: "batch/v1", kind: "CronJob", metadata: { name: "c", uid: "u" } })).toBeNull()
    expect(await resolveOwnedPods({ ...deployment, metadata: { name: "web", namespace: "prod" } })).toBeNull()
    expect(mockedTable).not.toHaveBeenCalled()
  })
})
