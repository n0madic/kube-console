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
