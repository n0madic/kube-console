// Discovery query: cached per session, shared by sidebar and pages.

import { useQuery } from "@tanstack/vue-query"
import { computed } from "vue"

import { fetchDiscovery } from "@/api/ui"
import type { DiscoveryResource } from "@/api/types"
import { useAuthStore } from "@/stores/auth"
import { compareKubeVersions } from "@/utils/k8sNames"

export function useDiscovery() {
  const auth = useAuthStore()
  const query = useQuery({
    // Keyed by the active context so switching clusters rebuilds the sidebar
    // from the new cluster's discovery (and keeps the old one cached for an
    // instant switch-back). Gated on an actual session: switching to a
    // not-yet-authorized context must not fire a tokenless request that 401s
    // through the global logout handler.
    queryKey: computed(() => ["discovery", auth.activeContext]),
    queryFn: fetchDiscovery,
    enabled: computed(() => auth.isAuthenticated),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })

  const resources = computed<DiscoveryResource[]>(() => query.data.value?.resources ?? [])

  /** Find a discovery entry for route params (group may be "core"). */
  function findResource(group: string, version: string, resource: string): DiscoveryResource | undefined {
    const apiGroup = group === "core" ? "" : group
    return resources.value.find(
      (r) => r.group === apiGroup && r.version === version && r.resource === resource,
    )
  }

  /**
   * Whether a discovery entry can back a detail-page link: every consumer of
   * findByKind/findByLowerKind resolves a route the detail page then GETs, so a
   * kind that does not support `get` would only 405/403. A resource that
   * declares verbs WITHOUT `get` (create-only reviews like TokenReview /
   * SubjectAccessReview) is rejected; one that declares no verbs at all is
   * kept, because nonstandard aggregated APIs omit the list entirely (the
   * backend normalizes that to []), and treating "unknown" as "not gettable"
   * would drop live links to CRDs — discovery hides nothing on assumptions.
   */
  function canGet(r: DiscoveryResource): boolean {
    const verbs = r.verbs ?? []
    return verbs.length === 0 || verbs.includes("get")
  }

  /** Find a discovery entry by object apiVersion + kind (ownerReferences). */
  function findByKind(apiVersion: string, kind: string): DiscoveryResource | undefined {
    const slash = apiVersion.indexOf("/")
    const group = slash >= 0 ? apiVersion.slice(0, slash) : ""
    const version = slash >= 0 ? apiVersion.slice(slash + 1) : apiVersion
    return resources.value.find(
      (r) => r.group === group && r.version === version && r.kind === kind && canGet(r),
    )
  }

  /**
   * Find a discovery entry by kind alone, case-insensitively: the Table
   * printer renders an event's involved object as "pod/nginx-1" — lowercased
   * kind, no apiVersion — and RBAC-style references carry a group but no
   * version, so neither has an apiVersion to match on. The core group wins (a
   * bare "event" means the core one), then the highest-priority version,
   * matching the sidebar's dedupe. `group` narrows the search when known.
   */
  function findByLowerKind(kind: string, group?: string): DiscoveryResource | undefined {
    const wanted = kind.toLowerCase()
    let best: DiscoveryResource | undefined
    for (const r of resources.value) {
      if (r.kind.toLowerCase() !== wanted) continue
      if (group !== undefined && r.group !== group) continue
      if (!canGet(r)) continue
      if (best === undefined) {
        best = r
        continue
      }
      if (r.group !== best.group) {
        if (r.group === "") best = r
        continue
      }
      if (compareKubeVersions(r.version, best.version) > 0) best = r
    }
    return best
  }

  return { ...query, resources, findResource, findByKind, findByLowerKind }
}
