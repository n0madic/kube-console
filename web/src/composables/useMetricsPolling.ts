// Metrics polling: capability-gated, interval >= 15s, paused while the tab
// is hidden. Samples live only in the caller's in-memory ring buffers. The
// visibility/schedule/generation mechanics live in usePollingLoop.

import { computed, ref } from "vue"

import { messageFromError } from "@/api/http"
import { fetchMetricsCapabilities } from "@/api/ui"
import type { MetricsCapabilities, MetricsResponse } from "@/api/types"
import { usePreferencesStore } from "@/stores/preferences"

import { usePollingLoop } from "./usePollingLoop"

export type MetricsUIState =
  | "loading"
  | "available"
  | "not-installed"
  | "forbidden"
  | "unavailable"
  | "disabled"
  | "user-disabled"

export interface MetricsPollingOptions {
  fetcher: () => Promise<MetricsResponse>
  onSample: (response: MetricsResponse) => void
}

const MIN_INTERVAL_SECONDS = 15

export function useMetricsPolling(options: MetricsPollingOptions) {
  const prefs = usePreferencesStore()
  const capabilities = ref<MetricsCapabilities | null>(null)
  const error = ref<string | null>(null)
  const userDisabled = ref(false)

  const state = computed<MetricsUIState>(() => {
    if (userDisabled.value) return "user-disabled"
    if (capabilities.value === null) return "loading"
    return capabilities.value.state
  })

  function intervalMs(): number {
    return Math.max(MIN_INTERVAL_SECONDS, prefs.prefs.metrics.pollIntervalSeconds) * 1000
  }

  async function tick(gen: number): Promise<void> {
    if (document.hidden) return // no polling in background tabs
    try {
      const resp = await options.fetcher()
      // Superseded (scope switch, stop, unmount) during the await: the caller
      // may have rebound its sample target, so delivering this would
      // contaminate the new scope.
      if (!loop.isCurrent(gen)) return
      error.value = null
      options.onSample(resp)
    } catch (e) {
      if (!loop.isCurrent(gen)) return
      error.value = messageFromError(e, "metrics request failed")
    }
  }

  // The gate's post-await writes are generation-guarded like tick's: two
  // clusters can genuinely differ (metrics-server installed in one, not the
  // other), so a stale probe landing after a context switch would report the
  // wrong state. The loop's own generation is not live yet while the gate runs,
  // so the probe carries its own counter — and hands it to the loop's onStop
  // hook, which exists for exactly this kind of in-flight work the generation
  // cannot see (useClusterSummary uses it the same way). Without that, a probe
  // outstanding across a plain stop() would still write capabilities.
  let gateGen = 0

  const loop = usePollingLoop(tick, intervalMs, () => {
    gateGen += 1
  })

  // Loop entry gate: probe metrics capabilities and only enter the poll loop
  // when metrics are available. Runs on behalf of the user token per start().
  async function gate(): Promise<boolean> {
    const myGate = ++gateGen
    userDisabled.value = false
    if (!prefs.prefs.metrics.enabled) {
      userDisabled.value = true
      return false
    }
    let probed: MetricsCapabilities
    try {
      probed = await fetchMetricsCapabilities()
    } catch {
      probed = { state: "unavailable" }
    }
    if (myGate !== gateGen) return false
    capabilities.value = probed
    return probed.state === "available"
  }

  function start(): Promise<void> {
    return loop.start(gate)
  }

  return { state, error, start, stop: loop.stop }
}
