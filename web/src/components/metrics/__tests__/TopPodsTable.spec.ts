import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

import type { MetricsItem } from "@/api/types"
import TopPodsTable from "@/components/metrics/TopPodsTable.vue"

// Descending cpu/memory, so item i is the i-th heaviest.
function items(count: number): MetricsItem[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "Pod" as const,
    namespace: "prod",
    name: `pod-${i}`,
    cpuNanoCores: (count - i) * 1_000_000,
    memoryBytes: (count - i) * 1_048_576,
  }))
}

function mountTable(list: MetricsItem[], sortBy: "cpu" | "memory" = "cpu") {
  return mount(TopPodsTable, {
    props: { title: "Top pods by CPU", items: list, sortBy },
    global: { stubs: { RouterLink: { props: ["to"], template: "<a><slot /></a>" } } },
  })
}

describe("TopPodsTable", () => {
  it("renders every pod when there are fewer than the cap", () => {
    const wrapper = mountTable(items(3))
    expect(wrapper.findAll("tbody tr")).toHaveLength(3)
  })

  // The cap is a fixed constant, not a prop: the card is a glance beside its twin.
  it("caps the list at 10 rows, keeping the heaviest", () => {
    const wrapper = mountTable(items(25))
    const rows = wrapper.findAll("tbody tr")
    expect(rows).toHaveLength(10)
    expect(rows[0]?.text()).toContain("pod-0")
    expect(rows[9]?.text()).toContain("pod-9")
    expect(wrapper.text()).not.toContain("pod-10")
  })

  it("sorts by the requested axis without mutating the input", () => {
    const list = items(3).reverse() // ascending, so sorting has to reorder
    const original = [...list]
    const wrapper = mountTable(list, "memory")
    expect(wrapper.findAll("tbody tr").map((r) => r.find("a").text())).toEqual([
      "pod-0",
      "pod-1",
      "pod-2",
    ])
    expect(list).toEqual(original)
  })

  it("shows the empty state instead of a table with no rows", () => {
    const wrapper = mountTable([])
    expect(wrapper.find("table").exists()).toBe(false)
    expect(wrapper.text()).toContain("No pod metrics.")
  })
})
