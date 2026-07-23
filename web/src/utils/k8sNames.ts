// Kubernetes version priority comparison and route helpers.

/**
 * Sentinel used in detail routes for cluster-scoped resources. "_" is not a
 * valid DNS-1123 label, so it can never collide with a real namespace.
 */
export const CLUSTER_SCOPE_SENTINEL = "_"

const VERSION_RE = /^v(\d+)(?:(alpha|beta)(\d+))?$/

/**
 * Compare Kubernetes API versions by convention: GA > beta > alpha, then by
 * major number, then by pre-release number. Returns >0 when a is newer.
 */
export function compareKubeVersions(a: string, b: string): number {
  const pa = VERSION_RE.exec(a)
  const pb = VERSION_RE.exec(b)
  if (pa === null && pb === null) return a.localeCompare(b)
  if (pa === null) return -1
  if (pb === null) return 1
  const stageRank = (stage: string | undefined): number =>
    stage === undefined ? 2 : stage === "beta" ? 1 : 0
  const stageDiff = stageRank(pa[2]) - stageRank(pb[2])
  if (stageDiff !== 0) return stageDiff
  const majorDiff = Number(pa[1]) - Number(pb[1])
  if (majorDiff !== 0) return majorDiff
  return Number(pa[3] ?? 0) - Number(pb[3] ?? 0)
}

/** Group segment used in routes: the core group is spelled "core". */
export function routeGroup(group: string): string {
  return group === "" ? "core" : group
}
