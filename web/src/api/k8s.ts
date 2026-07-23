// Kubernetes resource layer: every call goes through the /k8s gateway with
// native Kubernetes API semantics (Table representation, server-side apply,
// watch, log streams).

import { listToTable } from "@/utils/tableFallback"

import { apiFetch } from "./http"
import type {
  K8sObject,
  K8sObjectList,
  K8sTable,
  K8sTableColumn,
  K8sTableRow,
  ResourceRef,
} from "./types"

export const TABLE_ACCEPT =
  "application/json;as=Table;v=v1;g=meta.k8s.io,application/json"

function isCoreGroup(group: string): boolean {
  return group === "" || group === "core"
}

/** Build a gateway URL path for a resource collection or object. */
export function resourcePath(
  ref: ResourceRef,
  opts: { namespace?: string; name?: string; subresource?: string } = {},
): string {
  const base = isCoreGroup(ref.group)
    ? `/k8s/api/${encodeURIComponent(ref.version)}`
    : `/k8s/apis/${encodeURIComponent(ref.group)}/${encodeURIComponent(ref.version)}`
  let path = base
  if (opts.namespace !== undefined && opts.namespace !== "") {
    path += `/namespaces/${encodeURIComponent(opts.namespace)}`
  }
  path += `/${encodeURIComponent(ref.resource)}`
  if (opts.name !== undefined && opts.name !== "") {
    path += `/${encodeURIComponent(opts.name)}`
  }
  if (opts.subresource !== undefined) {
    path += `/${encodeURIComponent(opts.subresource)}`
  }
  return path
}

export interface ListOptions {
  namespace?: string
  limit?: number
  continueToken?: string
  labelSelector?: string
  fieldSelector?: string
}

export interface ListResult {
  table: K8sTable
  resourceVersion: string
  continueToken: string
  /** True when the server does not support Table and the list was converted. */
  fallback: boolean
}

/**
 * List resources as a Kubernetes Table. Falls back to converting a plain
 * List when the server (some aggregated APIs) ignores the Table Accept.
 */
export async function listAsTable(ref: ResourceRef, opts: ListOptions = {}): Promise<ListResult> {
  const params = new URLSearchParams()
  params.set("includeObject", "Metadata")
  if (opts.limit !== undefined) params.set("limit", String(opts.limit))
  if (opts.continueToken !== undefined && opts.continueToken !== "") {
    params.set("continue", opts.continueToken)
  }
  if (opts.labelSelector !== undefined && opts.labelSelector !== "") {
    params.set("labelSelector", opts.labelSelector)
  }
  if (opts.fieldSelector !== undefined && opts.fieldSelector !== "") {
    params.set("fieldSelector", opts.fieldSelector)
  }
  const path = `${resourcePath(ref, { namespace: opts.namespace })}?${params.toString()}`
  const resp = await apiFetch(path, { headers: { Accept: TABLE_ACCEPT } })
  const body: unknown = await resp.json()
  const asRecord = body as { kind?: string }

  if (asRecord.kind === "Table") {
    const table = body as K8sTable
    return {
      table,
      resourceVersion: table.metadata?.resourceVersion ?? "",
      continueToken: table.metadata?.continue ?? "",
      fallback: false,
    }
  }
  const list = body as K8sObjectList
  const table = listToTable(list)
  return {
    table,
    resourceVersion: list.metadata?.resourceVersion ?? "",
    continueToken: list.metadata?.continue ?? "",
    fallback: true,
  }
}

export interface TableWalkOptions extends ListOptions {
  /** Page cap; the walk stops after this many pages even if more rows remain. */
  maxPages?: number
  /** Checked after each page fetch; returning true aborts the walk. */
  shouldAbort?: () => boolean
  /** Row predicate; only matching rows are accumulated (default: keep all). */
  keepRow?: (row: K8sTableRow) => boolean
  /** Stop once this many rows have been kept (client-side match cap). */
  maxRows?: number
}

export interface WalkResult {
  columnDefinitions: K8sTableColumn[]
  /** Accumulated rows (post-keepRow when a filter is given). */
  rows: K8sTableRow[]
  /** True when the server did not support Table and the first page was converted. */
  fallback: boolean
  /** resourceVersion reported by the last page walked. */
  resourceVersion: string
  /** Continue token after the last walked page ("" when the collection ended). */
  continueToken: string
  /** True when a continue token remained after the cap/maxRows — more rows exist. */
  truncated: boolean
  /** Total rows fetched across pages, before keepRow filtering. */
  scanned: number
}

/**
 * Walk a Kubernetes Table collection across continue tokens, bounded by
 * maxPages × limit. Column definitions and the fallback flag come from the
 * first page; rows accumulate, optionally filtered by keepRow and capped by
 * maxRows. This is the single generic walker behind listAllAsTable and the
 * resource list's full-collection load and server-wide name search.
 */
export async function walkTable(ref: ResourceRef, opts: TableWalkOptions = {}): Promise<WalkResult> {
  const maxPages = opts.maxPages ?? 6
  const limit = opts.limit ?? 500
  let columnDefinitions: K8sTableColumn[] = []
  const rows: K8sTableRow[] = []
  let fallback = false
  let resourceVersion = ""
  let cont = opts.continueToken ?? ""
  let scanned = 0
  for (let page = 0; page < maxPages; page++) {
    const result = await listAsTable(ref, {
      namespace: opts.namespace,
      labelSelector: opts.labelSelector,
      fieldSelector: opts.fieldSelector,
      limit,
      continueToken: cont,
    })
    if (opts.shouldAbort?.() === true) break
    if (page === 0) {
      columnDefinitions = result.table.columnDefinitions ?? []
      fallback = result.fallback
    }
    resourceVersion = result.resourceVersion
    const pageRows = result.table.rows ?? []
    scanned += pageRows.length
    for (const row of pageRows) {
      if (opts.keepRow === undefined || opts.keepRow(row)) rows.push(row)
    }
    cont = result.continueToken
    if (cont === "") break
    if (opts.maxRows !== undefined && rows.length >= opts.maxRows) break
  }
  return {
    columnDefinitions,
    rows,
    fallback,
    resourceVersion,
    continueToken: cont,
    truncated: cont !== "",
    scanned,
  }
}

export interface TableWalkResult {
  table: K8sTable
  /** True when the page cap was hit and more rows exist. */
  truncated: boolean
}

/**
 * Fetch a Kubernetes Table across continue tokens into a single table. A thin
 * wrapper over walkTable for related-resource scans that inspect the whole
 * (bounded) set client-side (e.g. ownerReferences.uid filtering).
 */
export async function listAllAsTable(
  ref: ResourceRef,
  opts: Omit<ListOptions, "continueToken"> & { maxPages?: number } = {},
): Promise<TableWalkResult> {
  const walked = await walkTable(ref, opts)
  return {
    table: { kind: "Table", columnDefinitions: walked.columnDefinitions, rows: walked.rows },
    truncated: walked.truncated,
  }
}

/**
 * Raw node list for the cluster summary. Full objects (not Table) because we
 * need `status.allocatable` and `status.conditions`, which Table rows drop.
 */
export async function fetchNodes(): Promise<K8sObjectList> {
  const resp = await apiFetch(resourcePath({ group: "", version: "v1", resource: "nodes" }), {
    headers: { Accept: "application/json" },
  })
  return (await resp.json()) as K8sObjectList
}

/**
 * Approximate cluster-wide pod count via one lightweight Table page
 * (`includeObject=None` → cells only, no per-pod objects). For clusters larger
 * than the page limit the server's best-effort `remainingItemCount` fills the
 * rest; if the server omits it the count is a floor, which is acceptable for a
 * summary gauge.
 */
export async function fetchPodCount(): Promise<number> {
  const params = new URLSearchParams({ limit: "500", includeObject: "None" })
  const path = resourcePath({ group: "", version: "v1", resource: "pods" })
  const resp = await apiFetch(`${path}?${params.toString()}`, {
    headers: { Accept: TABLE_ACCEPT },
  })
  const body = (await resp.json()) as K8sTable
  const rows = body.rows?.length ?? 0
  return rows + (body.metadata?.remainingItemCount ?? 0)
}

export async function getObject(
  ref: ResourceRef,
  namespace: string | undefined,
  name: string,
): Promise<K8sObject> {
  const resp = await apiFetch(resourcePath(ref, { namespace, name }), {
    headers: { Accept: "application/json" },
  })
  return (await resp.json()) as K8sObject
}

export interface ApplyOptions {
  dryRun?: boolean
  force?: boolean
}

/**
 * Server-side apply of a YAML manifest. Never falls back to PUT; conflicts
 * surface as the native Kubernetes 409 Status.
 */
export async function serverSideApply(
  ref: ResourceRef,
  namespace: string | undefined,
  name: string,
  yamlBody: string,
  opts: ApplyOptions = {},
): Promise<K8sObject> {
  const params = new URLSearchParams()
  params.set("fieldManager", "kube-console")
  params.set("force", opts.force === true ? "true" : "false")
  if (opts.dryRun === true) params.set("dryRun", "All")
  const path = `${resourcePath(ref, { namespace, name })}?${params.toString()}`
  const resp = await apiFetch(path, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/apply-patch+yaml",
      Accept: "application/json",
    },
    body: yamlBody,
  })
  return (await resp.json()) as K8sObject
}

export type PatchType = "merge" | "strategic"

const PATCH_CONTENT_TYPES: Record<PatchType, string> = {
  merge: "application/merge-patch+json",
  strategic: "application/strategic-merge-patch+json",
}

/**
 * Targeted PATCH of one object or a subresource (`scale`). Used only by the
 * kind-specific actions, where SSA would conflict with fields owned by other
 * field managers (spec.replicas, the rollout restart annotation); generic YAML
 * edits stay on serverSideApply.
 */
export async function patchObject(
  ref: ResourceRef,
  namespace: string | undefined,
  name: string,
  patch: unknown,
  opts: { type?: PatchType; subresource?: string } = {},
): Promise<K8sObject> {
  const path = resourcePath(ref, { namespace, name, subresource: opts.subresource })
  const resp = await apiFetch(path, {
    method: "PATCH",
    headers: {
      "Content-Type": PATCH_CONTENT_TYPES[opts.type ?? "merge"],
      Accept: "application/json",
    },
    body: JSON.stringify(patch),
  })
  return (await resp.json()) as K8sObject
}

/** POST a new object into its collection (manual CronJob run). */
export async function createObject(
  ref: ResourceRef,
  namespace: string | undefined,
  object: K8sObject,
): Promise<K8sObject> {
  const resp = await apiFetch(resourcePath(ref, { namespace }), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(object),
  })
  return (await resp.json()) as K8sObject
}

export async function deleteObject(
  ref: ResourceRef,
  namespace: string | undefined,
  name: string,
): Promise<void> {
  await apiFetch(resourcePath(ref, { namespace, name }), {
    method: "DELETE",
    headers: { Accept: "application/json" },
  })
}

/** Events referencing the given object (native events API, involvedObject). */
export async function eventsFor(obj: K8sObject): Promise<K8sObjectList> {
  const meta = obj.metadata ?? {}
  const selectors: string[] = []
  if (meta.uid !== undefined) selectors.push(`involvedObject.uid=${meta.uid}`)
  if (meta.name !== undefined) selectors.push(`involvedObject.name=${meta.name}`)
  const params = new URLSearchParams()
  params.set("fieldSelector", selectors.join(","))
  params.set("limit", "200")
  const base = resourcePath(
    { group: "", version: "v1", resource: "events" },
    { namespace: meta.namespace },
  )
  const resp = await apiFetch(`${base}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  })
  return (await resp.json()) as K8sObjectList
}

export interface LogsOptions {
  container?: string
  tailLines?: number
  timestamps?: boolean
  previous?: boolean
  follow?: boolean
}

/** Build the gateway URL for the pod log subresource. */
export function logsUrl(namespace: string, pod: string, opts: LogsOptions = {}): string {
  const params = new URLSearchParams()
  if (opts.container !== undefined && opts.container !== "") {
    params.set("container", opts.container)
  }
  if (opts.tailLines !== undefined) params.set("tailLines", String(opts.tailLines))
  if (opts.timestamps === true) params.set("timestamps", "true")
  if (opts.previous === true) params.set("previous", "true")
  if (opts.follow === true) params.set("follow", "true")
  const query = params.toString()
  const base = resourcePath(
    { group: "", version: "v1", resource: "pods" },
    { namespace, name: pod, subresource: "log" },
  )
  return query === "" ? base : `${base}?${query}`
}

/** Build the watch URL for a resource collection. */
export function watchUrl(
  ref: ResourceRef,
  opts: { namespace?: string; resourceVersion: string; labelSelector?: string; fieldSelector?: string },
): string {
  const params = new URLSearchParams()
  params.set("watch", "true")
  params.set("allowWatchBookmarks", "true")
  params.set("includeObject", "Metadata")
  params.set("resourceVersion", opts.resourceVersion)
  if (opts.labelSelector !== undefined && opts.labelSelector !== "") {
    params.set("labelSelector", opts.labelSelector)
  }
  if (opts.fieldSelector !== undefined && opts.fieldSelector !== "") {
    params.set("fieldSelector", opts.fieldSelector)
  }
  return `${resourcePath(ref, { namespace: opts.namespace })}?${params.toString()}`
}
