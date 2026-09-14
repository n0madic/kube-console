// The pods an owner resolves to, walked once per detail page and shared by
// the workload Logs tab and the Related resources card (see
// composables/useOwnedPods.ts). Moved here from RelatedResourcesCard so the
// tab and the card cannot drift in what "owned" means.

import type { K8sObject, K8sObjectMeta, K8sTable, K8sTableRow } from "@/api/types"
import { PODS_REF, REPLICASETS_REF, ownedBy, podOwnerSpec } from "@/utils/ownedPods"
import { selectorToString, type LabelSelector } from "@/utils/selectors"

import { listAllAsTable } from "./k8s"

export interface OwnedPods {
  /** Rows already filtered to the owned (or, for a Service, selected) pods. */
  pods: K8sTable
  truncated: boolean
  /** Service only: the label selector the pods were matched by. */
  selector?: string
  /** Deployment only: its ReplicaSets, filtered by ownerReferences.uid. */
  replicaSets?: { table: K8sTable; truncated: boolean }
}

/** A synthetic Table holding the rows a predicate kept (as ProblemPodsCard builds). */
function filtered(table: K8sTable, keep: (m: K8sObjectMeta) => boolean): K8sTable {
  return {
    kind: "Table",
    columnDefinitions: table.columnDefinitions ?? [],
    rows: (table.rows ?? []).filter((row: K8sTableRow) => keep(row.object?.metadata ?? {})),
  }
}

// Parent selector as a label-selector string: every owner in the registry is
// a controller that guarantees its selector labels on its children, so the
// walk can be narrowed server-side. Empty → undefined (no narrowing).
function childSelector(object: K8sObject): string | undefined {
  const s = selectorToString((object.spec as { selector?: LabelSelector } | undefined)?.selector)
  return s !== "" ? s : undefined
}

async function resolveOwned(object: K8sObject, uid: string): Promise<OwnedPods> {
  // Narrow server-side by the parent's selector labels; the ownerReferences uid
  // filter stays the source of truth either way.
  const { table, truncated } = await listAllAsTable(PODS_REF, {
    namespace: object.metadata?.namespace,
    labelSelector: childSelector(object),
    maxPages: 6, // up to 3000 objects scanned
  })
  return { pods: filtered(table, ownedBy(uid)), truncated }
}

// Deployment: its ReplicaSets, plus the Pods those ReplicaSets own. Pods are
// grandchildren, so they can't be matched to the Deployment uid directly — we
// collect the owned ReplicaSet uids and match pods against that set.
async function resolveDeployment(object: K8sObject, uid: string): Promise<OwnedPods> {
  const namespace = object.metadata?.namespace
  const labelSelector = childSelector(object)
  // The ReplicaSet and Pod walks are independent — both are narrowed server-side
  // by the Deployment's own selector, and rsUids only gates the client-side pod
  // filter afterwards — so run them concurrently instead of back-to-back. (A
  // Deployment with no owned ReplicaSets does one wasted pods walk, a rare case.)
  const [rs, pods] = await Promise.all([
    listAllAsTable(REPLICASETS_REF, { namespace, labelSelector, maxPages: 6 }),
    listAllAsTable(PODS_REF, { namespace, labelSelector, maxPages: 6 }),
  ])
  const ownsDeployment = ownedBy(uid)
  const rsTable = filtered(rs.table, ownsDeployment)
  const rsUids = new Set(
    (rsTable.rows ?? [])
      .map((row) => row.object?.metadata?.uid)
      .filter((u): u is string => u !== undefined),
  )
  return {
    pods: filtered(pods.table, (m) =>
      (m.ownerReferences ?? []).some((o) => o.uid !== undefined && rsUids.has(o.uid)),
    ),
    // Either walk being cut short loses pods: a ReplicaSet past the page cap
    // contributes no uid to match against, so its pods are filtered out.
    truncated: rs.truncated || pods.truncated,
    replicaSets: { table: rsTable, truncated: rs.truncated },
  }
}

// Service: every pod its selector matches, ownership not considered.
async function resolveService(object: K8sObject): Promise<OwnedPods | null> {
  const selector = (object.spec as { selector?: Record<string, string> } | undefined)?.selector
  if (selector === undefined || Object.keys(selector).length === 0) return null
  const labelSelector = selectorToString({ matchLabels: selector })
  const { table, truncated } = await listAllAsTable(PODS_REF, {
    namespace: object.metadata?.namespace,
    labelSelector,
    maxPages: 4,
  })
  return { pods: table, truncated, selector: labelSelector }
}

/**
 * The pods this object owns or selects, or null when it is not a pod owner
 * (a kind outside the registry, no uid to match ownerReferences against, a
 * Service with no selector). The pods Table is always present on a non-null
 * result — possibly with no rows.
 */
export async function resolveOwnedPods(object: K8sObject): Promise<OwnedPods | null> {
  const spec = podOwnerSpec(object)
  if (spec === undefined) return null
  if (spec.mode === "service") return resolveService(object)
  const uid = object.metadata?.uid
  if (uid === undefined) return null
  return spec.mode === "deployment"
    ? resolveDeployment(object, uid)
    : resolveOwned(object, uid)
}
