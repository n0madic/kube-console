// The selected namespace is persisted per tab (sessionStorage) so a reload
// keeps it, but only there — never localStorage, and sidebarSearch stays
// transient.

import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { nextTick } from "vue"

import { PREFS_STORAGE_KEY, usePreferencesStore } from "@/stores/preferences"
import { NAMESPACE_STORAGE_KEY, useUiStore } from "@/stores/ui"
import { stubViewport, type ViewportStub } from "@/test/viewport"

describe("ui store namespace persistence", () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    setActivePinia(createPinia())
  })

  it("mirrors the selected namespace into sessionStorage", async () => {
    const ui = useUiStore()
    ui.namespace = "prod"
    await nextTick()
    expect(window.sessionStorage.getItem(NAMESPACE_STORAGE_KEY)).toBe("prod")
    expect(window.localStorage.getItem(NAMESPACE_STORAGE_KEY)).toBeNull()
  })

  it("restores the namespace after a reload (fresh pinia, same sessionStorage)", async () => {
    useUiStore().namespace = "kube-system"
    await nextTick() // let the persistence watcher flush

    // Simulate a page reload: new pinia instance, same sessionStorage.
    setActivePinia(createPinia())
    expect(useUiStore().namespace).toBe("kube-system")
  })

  it("clears the stored key when switching back to all namespaces", async () => {
    const ui = useUiStore()
    ui.namespace = "prod"
    await nextTick()
    ui.namespace = ""
    await nextTick()
    expect(window.sessionStorage.getItem(NAMESPACE_STORAGE_KEY)).toBeNull()

    // A reload now lands on all namespaces again.
    setActivePinia(createPinia())
    expect(useUiStore().namespace).toBe("")
  })

  it("defaults to all namespaces when nothing is stored", () => {
    expect(useUiStore().namespace).toBe("")
  })
})

// Sidebar visibility is two pieces of state: the user's choice on a wide
// viewport (persisted) and the narrow-viewport drawer (memory only). The point
// of the split is that auto-collapsing never rewrites the saved choice.
describe("ui store sidebar", () => {
  let viewport: ViewportStub

  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    viewport.restore()
  })

  it("shows the sidebar by default on a wide viewport and persists a collapse", async () => {
    viewport = stubViewport(false)
    const ui = useUiStore()
    expect(ui.narrowViewport).toBe(false)
    expect(ui.sidebarOpen).toBe(true)

    ui.toggleSidebar()
    await nextTick()

    expect(ui.sidebarOpen).toBe(false)
    expect(usePreferencesStore().prefs.sidebarCollapsed).toBe(true)
    const stored = JSON.parse(window.localStorage.getItem(PREFS_STORAGE_KEY) ?? "{}") as Record<
      string,
      unknown
    >
    expect(stored.sidebarCollapsed).toBe(true)
  })

  it("hides the sidebar by default on a narrow viewport, and the drawer is transient", async () => {
    viewport = stubViewport(true)
    const ui = useUiStore()
    const prefs = usePreferencesStore()
    expect(ui.narrowViewport).toBe(true)
    expect(ui.sidebarOpen).toBe(false)

    ui.toggleSidebar()
    await nextTick()

    expect(ui.sidebarOpen).toBe(true)
    // The drawer is not a preference: nothing was written.
    expect(prefs.prefs.sidebarCollapsed).toBe(false)
    expect(window.localStorage.getItem(PREFS_STORAGE_KEY)).toBeNull()

    ui.closeSidebar()
    await nextTick()
    expect(ui.sidebarOpen).toBe(false)
  })

  it("auto-collapses when the viewport narrows and restores the saved choice when it widens", async () => {
    viewport = stubViewport(false)
    const ui = useUiStore()
    const prefs = usePreferencesStore()
    // Sentinel: an explicit "sidebar stays open" choice on a wide viewport.
    expect(prefs.prefs.sidebarCollapsed).toBe(false)
    expect(ui.sidebarOpen).toBe(true)

    viewport.set(true)
    await nextTick()
    expect(ui.sidebarOpen).toBe(false)

    // Opening and leaving the drawer open must not survive the episode...
    ui.toggleSidebar()
    await nextTick()
    expect(ui.sidebarOpen).toBe(true)

    viewport.set(false)
    await nextTick()
    // ...and the wide viewport is back to what the user had chosen.
    expect(ui.sidebarOpen).toBe(true)
    expect(prefs.prefs.sidebarCollapsed).toBe(false)

    // Narrowing again starts from a closed drawer, not the one left open.
    viewport.set(true)
    await nextTick()
    expect(ui.sidebarOpen).toBe(false)
  })

  it("does not collapse the sidebar on a wide viewport via closeSidebar", async () => {
    viewport = stubViewport(false)
    const ui = useUiStore()

    ui.closeSidebar()
    await nextTick()

    expect(ui.sidebarOpen).toBe(true)
    expect(usePreferencesStore().prefs.sidebarCollapsed).toBe(false)
  })

  // The toggle moves between the TopBar and the sidebar header, so whatever
  // hides the sidebar takes the focused element with it.
  it("requests a focus handoff only when something was actually dismissed", async () => {
    viewport = stubViewport(true)
    const ui = useUiStore()
    expect(ui.consumeToggleFocus()).toBe(false)

    ui.toggleSidebar()
    await nextTick()
    expect(ui.consumeToggleFocus()).toBe(true)
    // One-shot: the instance that mounts next claims it, and only it.
    expect(ui.consumeToggleFocus()).toBe(false)

    ui.closeSidebar()
    expect(ui.consumeToggleFocus()).toBe(true)

    // A close that closes nothing must not move the focus — on a wide viewport
    // this runs on every navigation.
    ui.closeSidebar()
    expect(ui.consumeToggleFocus()).toBe(false)

    // …and a navigation that does close the drawer hands the user new content,
    // whose start is where the focus belongs: no handoff, or every sidebar link
    // would bounce it back onto the toggle.
    ui.toggleSidebar()
    await nextTick()
    ui.consumeToggleFocus()
    expect(ui.sidebarOpen).toBe(true)

    ui.closeSidebar(false)
    expect(ui.sidebarOpen).toBe(false)
    expect(ui.consumeToggleFocus()).toBe(false)
  })
})
