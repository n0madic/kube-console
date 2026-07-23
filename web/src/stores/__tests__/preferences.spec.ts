import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it } from "vitest"

import { sanitizePreferences, serializePreferences, usePreferencesStore } from "@/stores/preferences"

describe("preferences eventsOnlyWarnings", () => {
  it("defaults to false and ignores non-boolean input", () => {
    expect(sanitizePreferences({}).eventsOnlyWarnings).toBe(false)
    expect(sanitizePreferences({ eventsOnlyWarnings: "yes" }).eventsOnlyWarnings).toBe(false)
  })

  it("round-trips through serialize → sanitize", () => {
    const prefs = sanitizePreferences({ eventsOnlyWarnings: true })
    expect(prefs.eventsOnlyWarnings).toBe(true)
    const restored = sanitizePreferences(JSON.parse(serializePreferences(prefs)))
    expect(restored.eventsOnlyWarnings).toBe(true)
  })
})

describe("movePinned", () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
  })

  function store(order: string[]) {
    const s = usePreferencesStore()
    s.prefs.pinnedResources = [...order]
    return s
  }

  it("moves an entry down to the target position", () => {
    const s = store(["a", "b", "c", "d"])
    s.movePinned("a", "c")
    expect(s.prefs.pinnedResources).toEqual(["b", "c", "a", "d"])
  })

  it("moves an entry up to the target position", () => {
    const s = store(["a", "b", "c", "d"])
    s.movePinned("d", "b")
    expect(s.prefs.pinnedResources).toEqual(["a", "d", "b", "c"])
  })

  it("ignores unknown ids and self-drops", () => {
    const s = store(["a", "b"])
    s.movePinned("a", "a")
    s.movePinned("zz", "a")
    s.movePinned("a", "zz")
    expect(s.prefs.pinnedResources).toEqual(["a", "b"])
  })

  it("persists the new order to localStorage", async () => {
    const s = store(["a", "b", "c"])
    s.movePinned("c", "a")
    await new Promise((r) => setTimeout(r, 0))
    const raw = window.localStorage.getItem("kube-console.prefs.v1")
    expect(JSON.parse(raw ?? "{}").pinnedResources).toEqual(["c", "a", "b"])
  })
})
