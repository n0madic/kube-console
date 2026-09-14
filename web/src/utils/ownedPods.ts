// Pure half of the workload Logs tab: which kinds own pods and how, and how a
// pods Table becomes a picker list. Resolution (the cluster walk) lives in
// api/ownedPods.ts, the state in composables/useOwnedPods.ts.

import type { K8sObject, K8sObjectMeta, K8sTable, ResourceRef } from "@/api/types"
import { podColumnIndexes } from "@/utils/podHealth"
import { scalarCellText } from "@/utils/tableCells"

/**
 * How an owner reaches its pods: one ownerReferences hop, two hops through
 * ReplicaSets, or a Service's label selector (no ownership at all).
 */
export type PodOwnerMode = "owner" | "deployment" | "service"

export interface PodOwnerSpec {
  mode: PodOwnerMode
}

export const PODS_REF: ResourceRef = { group: "", version: "v1", resource: "pods" }
export const REPLICASETS_REF: ResourceRef = { group: "apps", version: "v1", resource: "replicasets" }

// kind key: "<apiVersion>/<Kind>" — same convention as actionsFor and
// PANEL_OWNED. CronJob is deliberately absent (many Jobs, each with its own
// Logs tab one click away), and so is Node (NodePodsCard is a list, not an
// owner).
const POD_OWNERS: Record<string, PodOwnerSpec> = {
  "apps/v1/Deployment": { mode: "deployment" },
  "apps/v1/ReplicaSet": { mode: "owner" },
  "apps/v1/StatefulSet": { mode: "owner" },
  "apps/v1/DaemonSet": { mode: "owner" },
  "batch/v1/Job": { mode: "owner" },
  "v1/Service": { mode: "service" },
}

export function podOwnerSpec(object: K8sObject): PodOwnerSpec | undefined {
  return POD_OWNERS[`${object.apiVersion ?? ""}/${object.kind ?? ""}`]
}

/** Row predicate: the object names `uid` among its owners. */
export function ownedBy(uid: string): (m: K8sObjectMeta) => boolean {
  return (m) => (m.ownerReferences ?? []).some((o) => o.uid === uid)
}

export interface PodChoice {
  name: string
  /** The printer's Status cell; "" when the Table carries no Status column. */
  status: string
  /** creationTimestamp in ms; -Infinity when absent or unparseable (sorts oldest). */
  createdMs: number
}

/**
 * Picker rows from a pods Table, newest first, ties broken by name so two
 * pods created in the same second list deterministically. Rows with no name
 * are dropped: a name is what the picker binds and what the GET is built from.
 */
export function podChoices(table: K8sTable): PodChoice[] {
  const cols = podColumnIndexes(table.columnDefinitions ?? [])
  const choices: PodChoice[] = []
  for (const row of table.rows ?? []) {
    const meta = row.object?.metadata
    const name = meta?.name ?? ""
    if (name === "") continue
    const stamp = meta?.creationTimestamp
    const created = stamp === undefined ? NaN : Date.parse(stamp)
    choices.push({
      name,
      status: cols.status < 0 ? "" : scalarCellText(row.cells[cols.status]),
      createdMs: Number.isNaN(created) ? Number.NEGATIVE_INFINITY : created,
    })
  }
  return choices.sort((a, b) => b.createdMs - a.createdMs || a.name.localeCompare(b.name))
}

/**
 * Which pod to stream first: the newest Running one, else the newest — a
 * Table with no Status column (the List→Table fallback) falls through to the
 * latter. "" when there is nothing to pick.
 */
export function defaultPodName(choices: PodChoice[]): string {
  const running = choices.find((c) => c.status.toLowerCase() === "running")
  return (running ?? choices[0])?.name ?? ""
}
