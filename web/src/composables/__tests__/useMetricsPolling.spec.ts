import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h, onMounted } from "vue"

import type { MetricsCapabilities, MetricsResponse } from "@/api/types"

vi.mock("@/api/ui", () => ({ fetchMetricsCapabilities: vi.fn() }))

import { fetchMetricsCapabilities } from "@/api/ui"
import { useMetricsPolling } from "@/composables/useMetricsPolling"

const mockedCaps = vi.mocked(fetchMetricsCapabilities)

const AVAILABLE: MetricsCapabilities = { state: "available" }
const sample: MetricsResponse = { observedAt: "t", windowSeconds: 15, items: [] }

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe("useMetricsPolling", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    mockedCaps.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("runs a single poll chain even when start() overlaps a previous start()", async () => {
    mockedCaps.mockResolvedValue(AVAILABLE)
    const fetcher = vi.fn().mockResolvedValue(sample)
    let polling!: ReturnType<typeof useMetricsPolling>
    const Host = defineComponent({
      setup() {
        polling = useMetricsPolling({ fetcher, onSample: () => {} })
        return () => h("div")
      },
    })
    mount(Host)

    // Two overlapping starts (e.g. onMounted + a quick namespace switch).
    const p1 = polling.start()
    const p2 = polling.start()
    await p1
    await p2
    await flush()

    const afterStart = fetcher.mock.calls.length
    // Advance three intervals (15s each). A single chain → exactly 3 fetches.
    await vi.advanceTimersByTimeAsync(45000)
    expect(fetcher.mock.calls.length - afterStart).toBe(3)
    polling.stop()
  })

  // Regression: tick() delivered onSample without re-checking the generation
  // after its await, so a fetch belonging to the previous scope pushed its
  // sample into the newly rebound buffer after a scope switch.
  it("drops a fetch that resolves after stop() instead of delivering the stale sample", async () => {
    mockedCaps.mockResolvedValue(AVAILABLE)
    let resolveFetch!: (r: MetricsResponse) => void
    const fetcher = vi.fn(
      () => new Promise<MetricsResponse>((resolve) => (resolveFetch = resolve)),
    )
    const onSample = vi.fn()
    let polling!: ReturnType<typeof useMetricsPolling>
    const Host = defineComponent({
      setup() {
        polling = useMetricsPolling({ fetcher, onSample })
        return () => h("div")
      },
    })
    mount(Host)

    const started = polling.start()
    await flush() // capabilities resolved; the first tick's fetch is pending
    expect(fetcher).toHaveBeenCalledTimes(1)

    polling.stop() // scope switch/unmount while the fetch is in flight
    resolveFetch(sample)
    await started
    await flush()

    expect(onSample).not.toHaveBeenCalled()
  })

  it("delivers samples for the live chain", async () => {
    mockedCaps.mockResolvedValue(AVAILABLE)
    const fetcher = vi.fn().mockResolvedValue(sample)
    const onSample = vi.fn()
    let polling!: ReturnType<typeof useMetricsPolling>
    const Host = defineComponent({
      setup() {
        polling = useMetricsPolling({ fetcher, onSample })
        return () => h("div")
      },
    })
    mount(Host)

    await polling.start()
    await flush()

    expect(onSample).toHaveBeenCalledWith(sample)
    polling.stop()
  })

  // Regression: the gate's own counter was bumped only by gate() itself, so a
  // capability probe outstanding across a plain stop() still wrote its verdict
  // — one cluster's "not-installed" could land on a screen that had already
  // stopped polling. The counter now rides usePollingLoop's onStop hook.
  it("drops a capability probe that resolves after stop()", async () => {
    let resolveCaps!: (c: MetricsCapabilities) => void
    mockedCaps.mockReturnValue(new Promise<MetricsCapabilities>((r) => (resolveCaps = r)))
    let polling!: ReturnType<typeof useMetricsPolling>
    const Host = defineComponent({
      setup() {
        polling = useMetricsPolling({
          fetcher: vi.fn().mockResolvedValue(sample),
          onSample: () => {},
        })
        return () => h("div")
      },
    })
    mount(Host)

    const started = polling.start()
    polling.stop() // the probe is still in flight
    resolveCaps({ state: "not-installed" })
    await started
    await flush()

    // Still "loading": nothing was learned about a cluster we stopped watching.
    expect(polling.state.value).toBe("loading")
  })

  it("adds no visibilitychange listener when unmounted during the capabilities fetch", async () => {
    let resolveCaps!: (c: MetricsCapabilities) => void
    mockedCaps.mockReturnValue(new Promise<MetricsCapabilities>((r) => (resolveCaps = r)))
    const addSpy = vi.spyOn(document, "addEventListener")

    const Host = defineComponent({
      setup() {
        const polling = useMetricsPolling({
          fetcher: vi.fn().mockResolvedValue(sample),
          onSample: () => {},
        })
        onMounted(() => void polling.start())
        return () => h("div")
      },
    })
    const wrapper = mount(Host)
    // Unmount (→ stop()) while the capabilities request is still pending.
    wrapper.unmount()
    resolveCaps(AVAILABLE)
    await flush()

    expect(
      addSpy.mock.calls.some(([type]) => type === "visibilitychange"),
    ).toBe(false)
  })
})
