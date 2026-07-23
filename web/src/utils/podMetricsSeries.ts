import type { ContainerUsage, MetricsItem } from "@/api/types"

/** CPU and memory series maps for one pod metrics sample, keyed by series label. */
export interface PodMetricsSeries {
  cpu: Record<string, number>
  mem: Record<string, number>
}

/**
 * Fill `out` with the per-container lines for one metric: the top `cap`
 * containers by this metric's value get their own line, the rest collapse into
 * an `other` sum. Sorting is per-metric, so the CPU and memory charts can
 * surface different containers (top CPU consumers vs. top memory consumers).
 */
function addContainerLines(
  out: Record<string, number>,
  containers: ContainerUsage[],
  cap: number,
  value: (c: ContainerUsage) => number,
): void {
  const sorted = [...containers].sort((a, b) => value(b) - value(a))
  sorted.slice(0, cap).forEach((c) => {
    out[c.name] = value(c)
  })
  const rest = sorted.slice(cap)
  if (rest.length > 0) {
    out["other"] = rest.reduce((sum, c) => sum + value(c), 0)
  }
}

/**
 * Build the per-sample series maps for a pod's CPU/memory charts.
 *
 * Series are always named by container. A single-container pod shows just that
 * container's line; only a multi-container pod adds a `total` aggregate on top.
 * Among the containers, the first `maxContainerSeries` by metric value get their
 * own line and the remaining small ones collapse into `other`. When no
 * per-container breakdown is reported, falls back to a single `total` line.
 */
export function podMetricsSeries(item: MetricsItem, maxContainerSeries: number): PodMetricsSeries {
  const containers = item.containers ?? []

  // No per-container breakdown available: fall back to the pod aggregate.
  if (containers.length === 0) {
    return { cpu: { total: item.cpuNanoCores }, mem: { total: item.memoryBytes } }
  }

  // Single container: name the line after it — no redundant "total".
  if (containers.length === 1) {
    const c = containers[0] as ContainerUsage
    return { cpu: { [c.name]: c.cpuNanoCores }, mem: { [c.name]: c.memoryBytes } }
  }

  // Multiple containers: aggregate "total" plus the heaviest per-container lines.
  const cpu: Record<string, number> = { total: item.cpuNanoCores }
  const mem: Record<string, number> = { total: item.memoryBytes }
  addContainerLines(cpu, containers, maxContainerSeries, (c) => c.cpuNanoCores)
  addContainerLines(mem, containers, maxContainerSeries, (c) => c.memoryBytes)
  return { cpu, mem }
}
