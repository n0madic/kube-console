import { describe, expect, it } from "vitest"

import type { MetricsItem } from "@/api/types"
import { podMetricsSeries } from "@/utils/podMetricsSeries"

function item(cpu: number, mem: number, containers?: MetricsItem["containers"]): MetricsItem {
  return { kind: "Pod", name: "p", cpuNanoCores: cpu, memoryBytes: mem, containers }
}

describe("podMetricsSeries", () => {
  it("names the single line after the container (no 'total')", () => {
    const { cpu, mem } = podMetricsSeries(item(100, 200, [{ name: "app", cpuNanoCores: 100, memoryBytes: 200 }]), 5)
    expect(cpu).toEqual({ app: 100 })
    expect(mem).toEqual({ app: 200 })
  })

  it("falls back to 'total' when no containers are reported", () => {
    const { cpu, mem } = podMetricsSeries(item(100, 200), 5)
    expect(cpu).toEqual({ total: 100 })
    expect(mem).toEqual({ total: 200 })
  })

  it("adds 'total' and sorts each metric independently by value", () => {
    const { cpu, mem } = podMetricsSeries(
      item(35, 300, [
        { name: "app", cpuNanoCores: 10, memoryBytes: 200 },
        { name: "sidecar", cpuNanoCores: 25, memoryBytes: 100 },
      ]),
      5,
    )
    // total first, then containers ordered by that metric's value (desc)
    expect(Object.keys(cpu)).toEqual(["total", "sidecar", "app"])
    expect(cpu).toEqual({ total: 35, sidecar: 25, app: 10 })
    expect(Object.keys(mem)).toEqual(["total", "app", "sidecar"])
    expect(mem).toEqual({ total: 300, app: 200, sidecar: 100 })
  })

  // Regression: the per-container loop wrote into the map already holding the
  // reserved keys, so a container legally named `total` replaced the pod
  // aggregate — a line still labelled "total" plotted one container's usage.
  it("keeps the pod aggregate when a container is named 'total'", () => {
    const { cpu, mem } = podMetricsSeries(
      item(1000, 3000, [
        { name: "total", cpuNanoCores: 7, memoryBytes: 10 },
        { name: "app", cpuNanoCores: 5, memoryBytes: 20 },
      ]),
      5,
    )
    expect(cpu).toEqual({ total: 1000, "total (container)": 7, app: 5 })
    expect(mem).toEqual({ total: 3000, app: 20, "total (container)": 10 })
  })

  // The other direction of the same collision: with the cap reached, the
  // rollup sum replaced a top-N container's own line named `other`.
  it("keeps a top-N container named 'other' separate from the rollup", () => {
    const { cpu } = podMetricsSeries(
      item(125, 40, [
        { name: "other", cpuNanoCores: 60, memoryBytes: 10 },
        { name: "app", cpuNanoCores: 50, memoryBytes: 10 },
        { name: "c3", cpuNanoCores: 10, memoryBytes: 10 },
        { name: "c4", cpuNanoCores: 5, memoryBytes: 10 },
      ]),
      2,
    )
    // top 2 by CPU keep their lines; the rollup is c3+c4, not the container.
    expect(cpu).toEqual({ total: 125, "other (container)": 60, app: 50, other: 15 })
  })

  it("keeps the heaviest 'cap' containers and collapses the rest into 'other'", () => {
    const containers = [
      { name: "c1", cpuNanoCores: 10, memoryBytes: 700 },
      { name: "c2", cpuNanoCores: 20, memoryBytes: 600 },
      { name: "c3", cpuNanoCores: 30, memoryBytes: 500 },
      { name: "c4", cpuNanoCores: 40, memoryBytes: 400 },
      { name: "c5", cpuNanoCores: 50, memoryBytes: 300 },
      { name: "c6", cpuNanoCores: 60, memoryBytes: 200 },
      { name: "c7", cpuNanoCores: 70, memoryBytes: 100 },
    ]
    const { cpu, mem } = podMetricsSeries(item(280, 2800, containers), 5)
    // CPU: top 5 are c7..c3, the two smallest (c2=20, c1=10) fold into other=30
    expect(Object.keys(cpu)).toEqual(["total", "c7", "c6", "c5", "c4", "c3", "other"])
    expect(cpu["other"]).toBe(30)
    // Memory ranks the opposite way: top 5 are c1..c5, other = c6+c7 = 300
    expect(Object.keys(mem)).toEqual(["total", "c1", "c2", "c3", "c4", "c5", "other"])
    expect(mem["other"]).toBe(300)
  })
})
