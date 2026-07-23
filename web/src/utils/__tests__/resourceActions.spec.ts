import { describe, expect, it } from "vitest"

import type { K8sObject } from "@/api/types"
import {
  RESTART_ANNOTATION,
  actionsFor,
  currentReplicas,
  defaultManualJobName,
  manualJobFromCronJob,
  replicasPatch,
  restartPatch,
  suspendPatch,
  unschedulablePatch,
} from "@/utils/resourceActions"

function obj(apiVersion: string, kind: string, spec: unknown = {}, name = "x"): K8sObject {
  return { apiVersion, kind, metadata: { name, namespace: "default" }, spec }
}

function ids(object: K8sObject): string[] {
  return actionsFor(object).map((a) => a.id)
}

describe("actionsFor", () => {
  it("offers scale and restart on workloads that have both", () => {
    expect(ids(obj("apps/v1", "Deployment"))).toEqual(["scale", "restart"])
    expect(ids(obj("apps/v1", "StatefulSet"))).toEqual(["scale", "restart"])
  })

  it("offers only restart on a DaemonSet and only scale on a ReplicaSet", () => {
    expect(ids(obj("apps/v1", "DaemonSet"))).toEqual(["restart"])
    expect(ids(obj("apps/v1", "ReplicaSet"))).toEqual(["scale"])
    expect(ids(obj("v1", "ReplicationController"))).toEqual(["scale"])
  })

  it("returns nothing for kinds without actions", () => {
    expect(actionsFor(obj("v1", "ConfigMap"))).toEqual([])
    expect(actionsFor(obj("v1", "Pod"))).toEqual([])
    expect(actionsFor(obj("example.com/v1", "Widget"))).toEqual([])
    expect(actionsFor({})).toEqual([])
  })

  it("resolves the suspend toggle from spec.suspend", () => {
    expect(ids(obj("batch/v1", "CronJob"))).toEqual(["trigger", "suspend"])
    expect(ids(obj("batch/v1", "CronJob", { suspend: false }))).toEqual(["trigger", "suspend"])
    expect(ids(obj("batch/v1", "CronJob", { suspend: true }))).toEqual(["trigger", "resume"])
    expect(ids(obj("batch/v1", "Job", { suspend: true }))).toEqual(["resume"])
  })

  it("resolves the cordon toggle from spec.unschedulable", () => {
    expect(ids(obj("v1", "Node"))).toEqual(["cordon"])
    expect(ids(obj("v1", "Node", { unschedulable: true }))).toEqual(["uncordon"])
  })

  it("labels actions and explains the effect (the dialog shows the target)", () => {
    const actions = actionsFor(obj("v1", "Node", {}, "node-1"))
    expect(actions[0]?.label).toBe("Cordon")
    expect(actions[0]?.confirm).toContain("stops accepting new pods")
  })

  it("words suspend for the kind it applies to", () => {
    const [cronJob] = actionsFor(obj("batch/v1", "CronJob")).slice(1)
    const [job] = actionsFor(obj("batch/v1", "Job"))
    expect(cronJob?.confirm).toContain("No new Jobs are scheduled")
    expect(job?.confirm).toContain("active pods are deleted")
  })
})

describe("patch builders", () => {
  it("builds the kubectl rollout restart annotation patch", () => {
    const patch = restartPatch(new Date("2026-07-21T10:11:12Z"))
    expect(RESTART_ANNOTATION).toBe("kubectl.kubernetes.io/restartedAt")
    expect(patch).toEqual({
      spec: {
        template: {
          metadata: {
            annotations: { "kubectl.kubernetes.io/restartedAt": "2026-07-21T10:11:12.000Z" },
          },
        },
      },
    })
  })

  it("builds replicas, suspend and unschedulable patches", () => {
    expect(replicasPatch(3)).toEqual({ spec: { replicas: 3 } })
    expect(replicasPatch(0)).toEqual({ spec: { replicas: 0 } })
    expect(suspendPatch(true)).toEqual({ spec: { suspend: true } })
    expect(suspendPatch(false)).toEqual({ spec: { suspend: false } })
    expect(unschedulablePatch(true)).toEqual({ spec: { unschedulable: true } })
  })

  it("reads the current replica count", () => {
    expect(currentReplicas(obj("apps/v1", "Deployment", { replicas: 4 }))).toBe(4)
    expect(currentReplicas(obj("apps/v1", "Deployment", {}))).toBe(0)
    expect(currentReplicas({})).toBe(0)
  })
})

describe("defaultManualJobName", () => {
  const now = new Date(1_800_000_000_000)

  it("appends -manual-<epochSec>", () => {
    expect(defaultManualJobName("backup", now)).toBe("backup-manual-1800000000")
  })

  it("truncates long names to 63 chars without a trailing separator", () => {
    const long = `${"a".repeat(40)}-${"b".repeat(30)}`
    const name = defaultManualJobName(long, now)
    expect(name.length).toBeLessThanOrEqual(63)
    expect(name.endsWith("-manual-1800000000")).toBe(true)
    expect(name).not.toContain("--manual")
  })

  it("drops the separator left by the cut", () => {
    const name = defaultManualJobName(`${"a".repeat(44)}-tail`, now)
    expect(name).toBe(`${"a".repeat(44)}-manual-1800000000`)
    expect(name.length).toBe(62)
  })
})

describe("manualJobFromCronJob", () => {
  const cronJob: K8sObject = {
    apiVersion: "batch/v1",
    kind: "CronJob",
    metadata: { name: "backup", namespace: "ops", uid: "uid-1" },
    spec: {
      schedule: "0 * * * *",
      suspend: false,
      jobTemplate: {
        metadata: { labels: { app: "backup" }, annotations: { owner: "team" } },
        spec: { backoffLimit: 2, template: { spec: { containers: [{ name: "c" }] } } },
      },
    },
  }

  it("copies the jobTemplate spec and marks the run as manual", () => {
    const job = manualJobFromCronJob(cronJob, "backup-manual-1")
    expect(job.apiVersion).toBe("batch/v1")
    expect(job.kind).toBe("Job")
    expect(job.metadata?.name).toBe("backup-manual-1")
    expect(job.metadata?.labels).toEqual({ app: "backup" })
    expect(job.metadata?.annotations).toEqual({
      "cronjob.kubernetes.io/instantiate": "manual",
      owner: "team",
    })
    expect(job.spec).toEqual({
      backoffLimit: 2,
      template: { spec: { containers: [{ name: "c" }] } },
    })
  })

  it("owns the job by the cronjob, like kubectl (no controller flags)", () => {
    const job = manualJobFromCronJob(cronJob, "backup-manual-1")
    expect(job.metadata?.ownerReferences).toEqual([
      { apiVersion: "batch/v1", kind: "CronJob", name: "backup", uid: "uid-1" },
    ])
  })

  it("omits ownerReferences when the cronjob has no uid", () => {
    const withoutUid: K8sObject = { ...cronJob, metadata: { name: "backup" } }
    const job = manualJobFromCronJob(withoutUid, "backup-manual-1")
    expect(job.metadata?.ownerReferences).toBeUndefined()
    expect(job.metadata?.annotations?.["cronjob.kubernetes.io/instantiate"]).toBe("manual")
  })

  it("survives a cronjob without a jobTemplate", () => {
    const job = manualJobFromCronJob({ apiVersion: "batch/v1", kind: "CronJob" }, "j")
    expect(job.spec).toEqual({})
  })
})
