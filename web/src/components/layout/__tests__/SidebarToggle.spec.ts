// The toggle is mounted in the sidebar header while it is open and in the
// TopBar while it is hidden, so activating it destroys the element that has the
// focus. The instance mounting in its place claims the handoff the store left.

import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import SidebarToggle from "@/components/layout/SidebarToggle.vue"
import { useUiStore } from "@/stores/ui"
import { stubViewport, type ViewportStub } from "@/test/viewport"

let viewport: ViewportStub
let wrappers: Array<ReturnType<typeof mount>> = []

// Attached to the document: focus() does nothing on a detached element.
function mountToggle() {
  const wrapper = mount(SidebarToggle, { attachTo: document.body })
  wrappers.push(wrapper)
  return wrapper
}

describe("SidebarToggle", () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
    viewport = stubViewport(false)
  })

  afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount()
    wrappers = []
    viewport.restore()
  })

  it("labels itself by what a click will do", async () => {
    const ui = useUiStore()
    const wrapper = mountToggle()

    expect(wrapper.get("button").attributes("aria-label")).toBe("Hide sidebar")
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("true")

    await wrapper.get("button").trigger("click")

    expect(ui.sidebarOpen).toBe(false)
    expect(wrapper.get("button").attributes("aria-label")).toBe("Show sidebar")
  })

  it("hands the focus to the instance that replaces it", async () => {
    const wrapper = mountToggle()
    await wrapper.get("button").trigger("click")

    // In the app the clicked instance unmounts and the other one mounts; here
    // the second mount stands in for it.
    const next = mountToggle()

    expect(document.activeElement).toBe(next.get("button").element)
  })

  it("does not steal the focus when it mounts on its own", () => {
    const first = mountToggle()
    // A plain app start: no toggle happened, so focus stays where it was.
    expect(document.activeElement).not.toBe(first.get("button").element)

    const second = mountToggle()
    expect(document.activeElement).not.toBe(second.get("button").element)
  })
})
