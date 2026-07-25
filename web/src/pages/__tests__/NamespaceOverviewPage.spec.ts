import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/api/ui", () => ({
  fetchMetricsCapabilities: vi.fn(),
  fetchNamespacePodMetrics: vi.fn(),
  fetchAllNodeMetrics: vi.fn(),
}))

import type { MetricsCapabilities, MetricsResponse } from "@/api/types"
import { fetchMetricsCapabilities, fetchNamespacePodMetrics } from "@/api/ui"
import NamespaceOverviewPage from "@/pages/NamespaceOverviewPage.vue"
import { useAuthStore } from "@/stores/auth"
import { clearMetricsCacheContext } from "@/utils/metricsCache"

const mockedCaps = vi.mocked(fetchMetricsCapabilities)
const mockedMetrics = vi.mocked(fetchNamespacePodMetrics)

const AVAILABLE: MetricsCapabilities = { state: "available" }
const sample: MetricsResponse = { observedAt: "2026-07-25T10:00:00Z", windowSeconds: 15, items: [] }

// Every mounted page keeps its polling timer and visibilitychange listener
// until it is unmounted, so a leftover would keep polling into the next test.
const mounted: Array<ReturnType<typeof mount>> = []

function mountPage() {
  const wrapper = mount(NamespaceOverviewPage, {
    global: {
      // The cluster-wide cards run their own scans; only this page's metrics
      // polling is under test.
      stubs: {
        ClusterSummaryCards: true,
        ProblemPodsCard: true,
        RecentEventsCard: true,
        TopPodsTable: true,
        MetricsChart: true,
        MetricsUnavailable: true,
      },
    },
  })
  mounted.push(wrapper)
  return wrapper
}

describe("NamespaceOverviewPage", () => {
  beforeEach(() => {
    // Sessions and the namespace mirror (sessionStorage) plus the shared
    // metrics cache outlive a pinia reset; all are keyed by these contexts.
    window.sessionStorage.clear()
    clearMetricsCacheContext("alpha")
    clearMetricsCacheContext("beta")
    setActivePinia(createPinia())
    mockedCaps.mockReset()
    mockedMetrics.mockReset()
  })

  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
  })

  it("restarts polling on a context switch with a session", async () => {
    mockedCaps.mockResolvedValue(AVAILABLE)
    mockedMetrics.mockResolvedValue(sample)
    const auth = useAuthStore()
    auth.setSession("alpha", "tok-alpha", null, false)

    mountPage()
    await flushPromises()
    expect(mockedCaps).toHaveBeenCalledTimes(1)

    auth.setSession("beta", "tok-beta", null, false)
    await flushPromises()
    expect(mockedCaps).toHaveBeenCalledTimes(2)
  })

  // Regression: the context watch restarted polling unconditionally, and
  // start()'s first act is the capabilities probe — switching to a context
  // with no session fired a tokenless request whose 401 ran the global
  // handler and replaced the switcher's /login?redirect=… route.
  it("does not probe capabilities when the new context has no session", async () => {
    mockedCaps.mockResolvedValue(AVAILABLE)
    mockedMetrics.mockResolvedValue(sample)
    const auth = useAuthStore()
    auth.setSession("alpha", "tok-alpha", null, false)

    mountPage()
    await flushPromises()
    expect(mockedCaps).toHaveBeenCalledTimes(1)

    auth.setActiveContext("beta") // no session for beta
    await flushPromises()
    expect(mockedCaps).toHaveBeenCalledTimes(1)
    expect(mockedMetrics).toHaveBeenCalledTimes(1)
  })
})
