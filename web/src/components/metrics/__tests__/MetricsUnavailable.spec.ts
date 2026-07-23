import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"

import MetricsUnavailable from "@/components/metrics/MetricsUnavailable.vue"
import {
  useMetricsPolling,
  type MetricsUIState,
} from "@/composables/useMetricsPolling"
import { usePreferencesStore } from "@/stores/preferences"

vi.mock("@/api/ui", () => ({
  fetchMetricsCapabilities: vi.fn(),
}))

import { fetchMetricsCapabilities } from "@/api/ui"

const mockedCaps = vi.mocked(fetchMetricsCapabilities)

describe("MetricsUnavailable", () => {
  it.each([
    ["not-installed", "not installed"],
    ["forbidden", "not allowed"],
    ["unavailable", "unreachable"],
    ["disabled", "disabled in the kube-console backend"],
    ["user-disabled", "turned off in your preferences"],
  ] as Array<[MetricsUIState, string]>)("renders a clear message for %s", (state, fragment) => {
    const wrapper = mount(MetricsUnavailable, { props: { state } })
    expect(wrapper.text().toLowerCase()).toContain(fragment.toLowerCase())
  })
})

describe("useMetricsPolling gating", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
    mockedCaps.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function setupPolling(fetcher: () => Promise<never>) {
    let polling!: ReturnType<typeof useMetricsPolling>
    const Host = defineComponent({
      setup() {
        polling = useMetricsPolling({ fetcher, onSample: () => {} })
        return () => h("div")
      },
    })
    mount(Host)
    return polling
  }

  it.each(["not-installed", "forbidden", "unavailable", "disabled"] as const)(
    "does not poll when capabilities report %s",
    async (state) => {
      mockedCaps.mockResolvedValue({ state })
      const fetcher = vi.fn(async () => {
        throw new Error("must not be called")
      })
      const polling = setupPolling(fetcher)
      await polling.start()
      expect(polling.state.value).toBe(state)
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it("does not even probe capabilities when the user disabled metrics", async () => {
    const prefs = usePreferencesStore()
    prefs.prefs.metrics.enabled = false
    const fetcher = vi.fn(async () => {
      throw new Error("must not be called")
    })
    const polling = setupPolling(fetcher)
    await polling.start()
    expect(polling.state.value).toBe("user-disabled")
    expect(mockedCaps).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("treats a failed capability probe as unavailable", async () => {
    mockedCaps.mockRejectedValue(new Error("boom"))
    const fetcher = vi.fn(async () => {
      throw new Error("must not be called")
    })
    const polling = setupPolling(fetcher)
    await polling.start()
    expect(polling.state.value).toBe("unavailable")
    expect(fetcher).not.toHaveBeenCalled()
  })
})
