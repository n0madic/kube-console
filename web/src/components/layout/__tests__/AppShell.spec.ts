// On a narrow viewport the sidebar is a drawer over the content, so it has to
// be dismissable by the backdrop, Esc and — since its links lead to exactly the
// content it covers — by navigating. None of that may collapse the in-flow
// sidebar on a wide viewport.

import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, reactive } from "vue"

const route = reactive({ fullPath: "/overview" })
vi.mock("vue-router", () => ({ useRoute: () => route }))

import AppShell from "@/components/layout/AppShell.vue"
import { useUiStore } from "@/stores/ui"

const BACKDROP = ".fixed.inset-0"

// Every mount is unmounted again: a leftover shell keeps watching the shared
// route object, and a watcher firing on its stale store would make pinia
// (whose action wrapper re-activates the store's own pinia) hand the next test
// the previous test's state.
let wrappers: Array<ReturnType<typeof mount>> = []

function mountShell() {
  const wrapper = mount(AppShell, {
    global: {
      stubs: {
        Sidebar: true,
        TopBar: true,
        ToastContainer: true,
        RouterView: true,
      },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

/** Narrow viewport with the drawer open. */
async function openDrawer() {
  const ui = useUiStore()
  ui.narrowViewport = true
  await nextTick() // the mode change resets the drawer before the toggle
  ui.toggleSidebar()
  await nextTick()
  expect(ui.sidebarOpen).toBe(true)
  return ui
}

describe("AppShell drawer", () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    setActivePinia(createPinia())
    route.fullPath = "/overview"
  })

  afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount()
    wrappers = []
  })

  it("renders the backdrop only in drawer mode and closes on a click", async () => {
    const wrapper = mountShell()
    const ui = useUiStore()
    // Wide viewport: the sidebar is in flow, nothing to dim.
    expect(ui.sidebarOpen).toBe(true)
    expect(wrapper.find(BACKDROP).exists()).toBe(false)

    await openDrawer()
    expect(wrapper.find(BACKDROP).exists()).toBe(true)

    await wrapper.get(BACKDROP).trigger("click")

    expect(ui.sidebarOpen).toBe(false)
    expect(wrapper.find(BACKDROP).exists()).toBe(false)
  })

  it("closes the drawer on Escape", async () => {
    mountShell()
    const ui = await openDrawer()

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    await nextTick()

    expect(ui.sidebarOpen).toBe(false)
  })

  it("closes the drawer on navigation", async () => {
    mountShell()
    const ui = await openDrawer()

    route.fullPath = "/resources/v1/pods"
    await nextTick()

    expect(ui.sidebarOpen).toBe(false)
  })

  it("leaves the sidebar alone on a wide viewport", async () => {
    mountShell()
    const ui = useUiStore()
    expect(ui.sidebarOpen).toBe(true)

    route.fullPath = "/resources/v1/pods"
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    await nextTick()

    expect(ui.sidebarOpen).toBe(true)
  })
})
