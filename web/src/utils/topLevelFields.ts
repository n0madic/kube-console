// Object fields that live outside the apiVersion/kind/metadata/spec/status
// skeleton. Plenty of kinds keep real content there and would otherwise render
// as a page with nothing but metadata: Event (type/reason/message/
// involvedObject), Secret/ConfigMap (immutable), StorageClass (provisioner,
// parameters, reclaimPolicy, …), EndpointSlice (addressType/endpoints/ports),
// Endpoints (subsets), RBAC (rules, roleRef, subjects), webhook configurations
// (webhooks), PriorityClass (value, globalDefault), RuntimeClass (handler), …
//
// Collected by shape, not by kind, so CRDs with top-level fields are covered
// too; the Overview renders the result with the same field tree as spec/status.

import type { K8sObject } from "@/api/types"

import { pruneEmpty } from "./fieldFilter"

const SKELETON_KEYS = new Set(["apiVersion", "kind", "metadata", "spec", "status"])

// Fields a dedicated Overview panel already renders, keyed "<apiVersion>/<Kind>"
// like the other registries. Repeating them in the generic tree would duplicate
// the panel — and for a Secret it would print the values the panel masks.
const PANEL_OWNED: Record<string, string[]> = {
  "v1/Secret": ["data", "stringData"],
  "v1/ConfigMap": ["data", "binaryData"],
}

/**
 * Top-level fields worth rendering, empty values pruned, or null when the
 * object has none (the common case: everything is in spec/status).
 */
export function topLevelFields(object: K8sObject): Record<string, unknown> | null {
  const owned = PANEL_OWNED[`${object.apiVersion ?? ""}/${object.kind ?? ""}`] ?? []
  // Null prototype: top-level keys come straight off the object, so one named
  // "__proto__" must become an own key instead of reaching the prototype
  // setter (which would drop it from the card entirely).
  const rest = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(object)) {
    if (SKELETON_KEYS.has(key) || owned.includes(key)) continue
    rest[key] = value
  }
  const pruned = pruneEmpty(rest) as Record<string, unknown>
  return Object.keys(pruned).length > 0 ? pruned : null
}
