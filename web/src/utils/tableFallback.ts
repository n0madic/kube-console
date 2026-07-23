// Convert a plain Kubernetes List into a Table shape for servers that do not
// support the Table representation. Fallback columns: Name, Namespace,
// Created, Status.

import type { K8sObject, K8sObjectList, K8sTable, K8sTableRow } from "@/api/types"

function statusOf(obj: K8sObject): string {
  const status = obj.status as
    | { phase?: unknown; conditions?: Array<{ type?: string; status?: string }> }
    | undefined
  if (status === undefined || status === null) return ""
  if (typeof status.phase === "string") return status.phase
  if (Array.isArray(status.conditions)) {
    const ready = status.conditions.find((c) => c.type === "Ready")
    if (ready !== undefined) return ready.status === "True" ? "Ready" : "NotReady"
  }
  return ""
}

export function listToTable(list: K8sObjectList): K8sTable {
  const rows: K8sTableRow[] = (list.items ?? []).map((obj) => ({
    cells: [
      obj.metadata?.name ?? "",
      obj.metadata?.namespace ?? "",
      obj.metadata?.creationTimestamp ?? "",
      statusOf(obj),
    ],
    object: {
      kind: obj.kind,
      apiVersion: obj.apiVersion,
      metadata: obj.metadata,
    },
  }))
  return {
    kind: "Table",
    metadata: list.metadata,
    columnDefinitions: [
      { name: "Name", type: "string" },
      { name: "Namespace", type: "string" },
      { name: "Created", type: "date" },
      { name: "Status", type: "string" },
    ],
    rows,
  }
}
