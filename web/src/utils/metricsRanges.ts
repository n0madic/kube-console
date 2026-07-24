// Chart range options shared by the three metric chart owners (PodMetricsTab,
// NodeMetricsTab, NamespaceOverviewPage): the selectable windows and their
// durations in seconds, kept in one place so a new or renamed range can never
// drift between the charts.

import type { MetricsRange } from "@/stores/preferences"

export const METRICS_RANGE_SECONDS: Record<MetricsRange, number> = {
  "5m": 300,
  "15m": 900,
  "1h": 3600,
}

export const METRICS_RANGE_OPTIONS = Object.keys(METRICS_RANGE_SECONDS) as MetricsRange[]

/**
 * Floor on the poll cadence, below the smallest selectable preference: the
 * Metrics API serves one scrape window (~15s by default), so asking faster only
 * re-reads the same sample — and every poll is a request per client.
 */
export const METRICS_MIN_INTERVAL_SECONDS = 15

/**
 * Poll cadence in ms for everything on the metrics loop — the three chart
 * owners via useMetricsPolling and the Overview gauges via useClusterSummary.
 * One definition, so the floor cannot drift between the two composables that
 * poll the same endpoints side by side on the same page.
 */
export function metricsIntervalMs(pollIntervalSeconds: number): number {
  return Math.max(METRICS_MIN_INTERVAL_SECONDS, pollIntervalSeconds) * 1000
}
