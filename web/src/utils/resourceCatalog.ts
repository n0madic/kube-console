// Build the sidebar catalog from discovery: common groups in curated
// sections, everything else under Custom & Other. Nothing is hidden based on
// RBAC assumptions; only non-listable resources are omitted.

import type { DiscoveryResource } from "@/api/types"
import { compareKubeVersions } from "./k8sNames"

export const SECTION_NAMES = [
  "Workloads",
  "Networking",
  "Configuration",
  "Storage",
  "RBAC",
  "Cluster",
  "Custom & Other",
] as const

export type SectionName = (typeof SECTION_NAMES)[number]

export interface CatalogSection {
  name: SectionName
  resources: DiscoveryResource[]
}

// key: "<group>/<resource>" (core group spelled "").
const SECTION_BY_RESOURCE: Record<string, SectionName> = {
  "/pods": "Workloads",
  "apps/deployments": "Workloads",
  "apps/statefulsets": "Workloads",
  "apps/daemonsets": "Workloads",
  "apps/replicasets": "Workloads",
  "batch/jobs": "Workloads",
  "batch/cronjobs": "Workloads",
  "/replicationcontrollers": "Workloads",

  "/services": "Networking",
  "/endpoints": "Networking",
  "discovery.k8s.io/endpointslices": "Networking",
  "networking.k8s.io/ingresses": "Networking",
  "networking.k8s.io/ingressclasses": "Networking",
  "networking.k8s.io/networkpolicies": "Networking",

  "/persistentvolumeclaims": "Storage",
  "/persistentvolumes": "Storage",
  "storage.k8s.io/storageclasses": "Storage",
  "storage.k8s.io/volumeattachments": "Storage",
  "storage.k8s.io/csidrivers": "Storage",
  "storage.k8s.io/csinodes": "Storage",

  "/configmaps": "Configuration",
  "/secrets": "Configuration",
  "/resourcequotas": "Configuration",
  "/limitranges": "Configuration",
  "autoscaling/horizontalpodautoscalers": "Configuration",
  "policy/poddisruptionbudgets": "Configuration",
  "scheduling.k8s.io/priorityclasses": "Configuration",

  "rbac.authorization.k8s.io/roles": "RBAC",
  "rbac.authorization.k8s.io/rolebindings": "RBAC",
  "rbac.authorization.k8s.io/clusterroles": "RBAC",
  "rbac.authorization.k8s.io/clusterrolebindings": "RBAC",
  "/serviceaccounts": "RBAC",

  "/namespaces": "Cluster",
  "/nodes": "Cluster",
  "/events": "Cluster",
  "events.k8s.io/events": "Cluster",
  "apiextensions.k8s.io/customresourcedefinitions": "Cluster",
  "apiregistration.k8s.io/apiservices": "Cluster",
  "coordination.k8s.io/leases": "Cluster",
  "node.k8s.io/runtimeclasses": "Cluster",
  "flowcontrol.apiserver.k8s.io/flowschemas": "Cluster",
  "flowcontrol.apiserver.k8s.io/prioritylevelconfigurations": "Cluster",
}

function sectionFor(res: DiscoveryResource): SectionName {
  const group = res.group === "core" ? "" : res.group
  return SECTION_BY_RESOURCE[`${group}/${res.resource}`] ?? "Custom & Other"
}

// Mirrored APIs exposing the same objects twice: hide the mirror when the
// canonical resource is present (e.g. events.k8s.io/events vs core events).
const MIRRORED_RESOURCES: Record<string, string> = {
  "events.k8s.io/events": "/events",
}

/**
 * Deduplicate by group/resource keeping the highest-priority version, keep
 * only listable resources, then bucket into sections.
 */
export function buildCatalog(resources: DiscoveryResource[]): CatalogSection[] {
  const byKey = new Map<string, DiscoveryResource>()
  for (const res of resources) {
    if (!(res.verbs ?? []).includes("list")) continue
    const key = `${res.group}/${res.resource}`
    const existing = byKey.get(key)
    if (existing === undefined || compareKubeVersions(res.version, existing.version) > 0) {
      byKey.set(key, res)
    }
  }
  const sections = new Map<SectionName, DiscoveryResource[]>()
  for (const name of SECTION_NAMES) sections.set(name, [])
  for (const res of byKey.values()) {
    const canonical = MIRRORED_RESOURCES[`${res.group}/${res.resource}`]
    if (canonical !== undefined && byKey.has(canonical)) continue
    sections.get(sectionFor(res))?.push(res)
  }
  const out: CatalogSection[] = []
  for (const name of SECTION_NAMES) {
    const list = sections.get(name) ?? []
    list.sort((a, b) => a.resource.localeCompare(b.resource))
    if (list.length > 0) out.push({ name, resources: list })
  }
  return out
}

/** Case-insensitive sidebar search over resource/kind/shortNames/group. */
export function matchesSearch(res: DiscoveryResource, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === "") return true
  return (
    res.resource.toLowerCase().includes(q) ||
    res.kind.toLowerCase().includes(q) ||
    res.group.toLowerCase().includes(q) ||
    (res.shortNames ?? []).some((s) => s.toLowerCase().includes(q))
  )
}
