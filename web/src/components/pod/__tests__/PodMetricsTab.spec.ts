import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/api/ui", () => ({
  fetchMetricsCapabilities: vi.fn(),
  fetchPodMetrics: vi.fn(),
}))

import type { MetricsCapabilities, MetricsResponse } from "@/api/types"
import { fetchMetricsCapabilities, fetchPodMetrics } from "@/api/ui"
import PodMetricsTab from "@/components/pod/PodMetricsTab.vue"
import { useAuthStore } from "@/stores/auth"
import { clearMetricsCacheContext } from "@/utils/metricsCache"

const mockedCaps = vi.mocked(fetchMetricsCapabilities)
const mockedMetrics = vi.mocked(fetchPodMetrics)

const AVAILABLE: MetricsCapabilities = { state: "available" }
const sample: MetricsResponse = { observedAt: "2026-07-25T10:00:00Z", windowSeconds: 15, items: [] }

// Every mounted tab keeps its polling timer and visibilitychange listener
// until it is unmounted, so a leftover would keep polling into the next test.
const mounted: Array<ReturnType<typeof mount>> = []

function mountTab() {
  const wrapper = mount(PodMetricsTab, {
    props: { object: { metadata: { uid: "u1", namespace: "ns", name: "p1" } } },
    global: { stubs: { MetricsChart: true, MetricsUnavailable: true } },
  })
  mounted.push(wrapper)
  return wrapper
}

describe("PodMetricsTab", () => {
  beforeEach(() => {
    // Sessions (sessionStorage) and the shared metrics cache outlive a pinia
    // reset; both are keyed by the contexts these tests use.
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

    mountTab()
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

    mountTab()
    await flushPromises()
    expect(mockedCaps).toHaveBeenCalledTimes(1)

    auth.setActiveContext("beta") // no session for beta
    await flushPromises()
    expect(mockedCaps).toHaveBeenCalledTimes(1)
    expect(mockedMetrics).toHaveBeenCalledTimes(1)
  })
})
