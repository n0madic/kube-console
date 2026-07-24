import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

vi.mock("@/composables/useClusterSummary", () => ({ useClusterSummary: vi.fn() }))

import type { ClusterSummary } from "@/composables/useClusterSummary"
import { useClusterSummary } from "@/composables/useClusterSummary"
import ClusterSummaryCards from "@/components/metrics/ClusterSummaryCards.vue"

const mockedUse = vi.mocked(useClusterSummary)
const routerLinkStub = { RouterLink: { props: ["to"], template: "<a><slot /></a>" } }

const summary: ClusterSummary = {
  cpu: { usedCores: 0.82, totalCores: 8 },
  memory: { usedBytes: 3_030_000_000, totalBytes: 32_212_254_720 },
  pods: { count: 31, capacity: 220 },
  nodes: { ready: 2, total: 2 },
}

function mockState(over: Partial<Record<string, unknown>> = {}) {
  const start = vi.fn()
  mockedUse.mockReturnValue({
    data: ref<ClusterSummary | null>(summary),
    available: ref(true),
    refresh: vi.fn(),
    start,
    stop: vi.fn(),
    ...over,
  } as unknown as ReturnType<typeof useClusterSummary>)
  return start
}

function mountCards(props: Record<string, unknown> = {}) {
  return mount(ClusterSummaryCards, { props, global: { stubs: routerLinkStub } })
}

describe("ClusterSummaryCards", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it("renders the four gauges and starts polling", () => {
    const start = mockState()
    const wrapper = mountCards()
    expect(start).toHaveBeenCalledOnce()
    const text = wrapper.text()
    // The section heading marks the row as cluster-wide, unaffected by the
    // namespace selector.
    expect(text).toContain("Cluster")
    expect(text).toContain("global view")
    expect(text).toContain("CPU Usage")
    expect(text).toContain("Memory Usage")
    expect(text).toContain("Pods")
    expect(text).toContain("Nodes")
    expect(text).toContain("31 / 220")
    expect(text).toContain("2 / 2 Ready")
  })

  it("links the Pods and Nodes cards to their resource lists", () => {
    mockState()
    const wrapper = mountCards()
    // CPU/Memory are plain sections; Pods/Nodes are links.
    expect(wrapper.findAll("a").length).toBe(2)
  })

  it("marks problem pods on the Pods gauge, against capacity", () => {
    mockState()
    const wrapper = mountCards({ problemPods: 11 })
    expect(wrapper.text()).toContain("11 in trouble")
    // 11 of the 220 capacity the fill is measured against, not of the 31 pods.
    const rose = wrapper.findAll("circle").filter((c) => c.classes().includes("text-rose-500"))
    expect(rose).toHaveLength(1)
    expect(rose[0]?.attributes("stroke-dasharray")).toBe("5 95")
  })

  it("marks a capped scan's count as a floor", () => {
    mockState()
    const wrapper = mountCards({ problemPods: 137, problemPodsTruncated: true })
    expect(wrapper.text()).toContain("137+ in trouble")
  })

  it("leaves the gauges untouched with no problem pods, and with none known", () => {
    mockState()
    for (const problemPods of [0, null]) {
      const wrapper = mountCards({ problemPods })
      expect(wrapper.text()).not.toContain("in trouble")
      expect(wrapper.findAll("circle").filter((c) => c.classes().includes("text-rose-500"))).toHaveLength(0)
    }
  })

  it("renders nothing when the cluster summary is unavailable", () => {
    mockState({ available: ref(false), data: ref<ClusterSummary | null>(null) })
    const wrapper = mountCards()
    expect(wrapper.find("section").exists()).toBe(false)
    expect(wrapper.text()).toBe("")
  })
})
