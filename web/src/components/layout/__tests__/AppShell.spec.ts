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
import { stubViewport, type ViewportStub } from "@/test/viewport"

const BACKDROP = ".fixed.inset-0"

let viewport: ViewportStub

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

/** Narrow viewport with the drawer open, driven through the media query the
 * store actually listens to. */
async function openDrawer() {
  const ui = useUiStore()
  viewport.set(true)
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
    viewport = stubViewport(false)
  })

  afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount()
    wrappers = []
    viewport.restore()
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

  // The drawer overlays the content, so what is behind it must not be
  // focusable, clickable or readable by a screen reader — one `inert`, which is
  // also what keeps Tab inside the drawer.
  it("makes the content behind the drawer inert, and only then", async () => {
    const wrapper = mountShell()
    // main's parent is the content column (TopBar + main).
    const content = wrapper.get("main").element.parentElement!
    expect(content.hasAttribute("inert")).toBe(false)

    const ui = await openDrawer()
    expect(content.hasAttribute("inert")).toBe(true)

    ui.closeSidebar()
    await nextTick()
    expect(content.hasAttribute("inert")).toBe(false)
  })

  // A nested handler (the cluster listbox in the sidebar, a dialog) cancels its
  // own Escape but does not stop it from bubbling to window, so dismissing a
  // popup used to close the drawer under it as well.
  it("ignores an Escape another handler has already taken", async () => {
    mountShell()
    const ui = await openDrawer()

    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true })
    event.preventDefault()
    window.dispatchEvent(event)
    await nextTick()

    expect(ui.sidebarOpen).toBe(true)
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
