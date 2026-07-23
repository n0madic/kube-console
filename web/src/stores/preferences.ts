// Preferences store: the ONLY state persisted to localStorage. Serialization
// goes through an explicit allowlist so nothing else (token, objects, logs)
// can ever leak into storage.

import { defineStore } from "pinia"
import { reactive, watch } from "vue"

export type MetricsPollInterval = 15 | 30 | 60
export type MetricsRange = "5m" | "15m" | "1h"

export interface UserPreferences {
  theme: "light" | "dark" | "system"
  defaultNamespace?: string
  pinnedResources: string[]
  hiddenColumns: Record<string, string[]>
  tablePageSize: number
  /** Recent-events card: show only Warning-type events. */
  eventsOnlyWarnings: boolean
  metrics: {
    enabled: boolean
    pollIntervalSeconds: MetricsPollInterval
    defaultRange: MetricsRange
  }
}

export const PREFS_STORAGE_KEY = "kube-console.prefs.v1"

/** Null-prototype map: hiddenColumns is keyed by discovery ids read back from
 * localStorage, so a stored "__proto__" key must become a plain own entry
 * instead of reaching the prototype setter — the allowlist above is only a
 * guarantee if the keys it copies cannot escape the object. */
function emptyHiddenColumns(): Record<string, string[]> {
  return Object.create(null) as Record<string, string[]>
}

function defaults(): UserPreferences {
  return {
    theme: "system",
    pinnedResources: [],
    hiddenColumns: emptyHiddenColumns(),
    tablePageSize: 50,
    eventsOnlyWarnings: false,
    metrics: { enabled: true, pollIntervalSeconds: 15, defaultRange: "15m" },
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
}

/** Rebuild preferences from unknown input, keeping only allowlisted fields. */
export function sanitizePreferences(input: unknown): UserPreferences {
  const out = defaults()
  if (typeof input !== "object" || input === null) return out
  const p = input as Record<string, unknown>

  if (p.theme === "light" || p.theme === "dark" || p.theme === "system") out.theme = p.theme
  if (typeof p.defaultNamespace === "string" && p.defaultNamespace !== "") {
    out.defaultNamespace = p.defaultNamespace
  }
  if (isStringArray(p.pinnedResources)) out.pinnedResources = p.pinnedResources
  if (typeof p.hiddenColumns === "object" && p.hiddenColumns !== null) {
    for (const [key, cols] of Object.entries(p.hiddenColumns as Record<string, unknown>)) {
      if (isStringArray(cols)) out.hiddenColumns[key] = cols
    }
  }
  if (typeof p.tablePageSize === "number" && p.tablePageSize >= 10 && p.tablePageSize <= 500) {
    out.tablePageSize = p.tablePageSize
  }
  if (typeof p.eventsOnlyWarnings === "boolean") out.eventsOnlyWarnings = p.eventsOnlyWarnings
  if (typeof p.metrics === "object" && p.metrics !== null) {
    const m = p.metrics as Record<string, unknown>
    if (typeof m.enabled === "boolean") out.metrics.enabled = m.enabled
    if (m.pollIntervalSeconds === 15 || m.pollIntervalSeconds === 30 || m.pollIntervalSeconds === 60) {
      out.metrics.pollIntervalSeconds = m.pollIntervalSeconds
    }
    if (m.defaultRange === "5m" || m.defaultRange === "15m" || m.defaultRange === "1h") {
      out.metrics.defaultRange = m.defaultRange
    }
  }
  return out
}

/** Serialize ONLY the allowlisted preference fields. */
export function serializePreferences(prefs: UserPreferences): string {
  const allowlisted: UserPreferences = {
    theme: prefs.theme,
    ...(prefs.defaultNamespace !== undefined ? { defaultNamespace: prefs.defaultNamespace } : {}),
    pinnedResources: [...prefs.pinnedResources],
    // Spread defines own properties, so a "__proto__" key stays a key here too.
    hiddenColumns: { ...prefs.hiddenColumns },
    tablePageSize: prefs.tablePageSize,
    eventsOnlyWarnings: prefs.eventsOnlyWarnings,
    metrics: { ...prefs.metrics },
  }
  return JSON.stringify(allowlisted)
}

function loadFromStorage(): UserPreferences {
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY)
    if (raw === null) return defaults()
    return sanitizePreferences(JSON.parse(raw))
  } catch {
    return defaults()
  }
}

export const usePreferencesStore = defineStore("preferences", () => {
  const prefs = reactive<UserPreferences>(loadFromStorage())

  watch(
    prefs,
    () => {
      try {
        window.localStorage.setItem(PREFS_STORAGE_KEY, serializePreferences(prefs))
      } catch {
        // storage full/unavailable: preferences simply do not persist
      }
    },
    { deep: true },
  )

  function togglePinned(resourceId: string): void {
    const idx = prefs.pinnedResources.indexOf(resourceId)
    if (idx >= 0) prefs.pinnedResources.splice(idx, 1)
    else prefs.pinnedResources.push(resourceId)
  }

  /**
   * Move a pinned resource to the position currently held by another one
   * (drag & drop reordering). Ids, not indices: the sidebar list may be
   * filtered by the search box, so visible positions are not storage ones.
   */
  function movePinned(sourceId: string, targetId: string): void {
    const list = prefs.pinnedResources
    const from = list.indexOf(sourceId)
    const to = list.indexOf(targetId)
    if (from < 0 || to < 0 || from === to) return
    list.splice(to, 0, ...list.splice(from, 1))
  }

  return { prefs, togglePinned, movePinned }
})
