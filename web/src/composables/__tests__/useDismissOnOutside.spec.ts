import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import { defineComponent, h, ref } from "vue"

import { useDismissOnOutside } from "@/composables/useDismissOnOutside"

function mountHost() {
  const close = vi.fn()
  const Host = defineComponent({
    setup() {
      const root = ref<HTMLElement | null>(null)
      useDismissOnOutside(root, close)
      return () => h("div", { ref: root }, [h("button", "inside")])
    },
  })
  const wrapper = mount(Host, { attachTo: document.body })
  return { wrapper, close }
}

function mousedown(target: EventTarget): void {
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
}

describe("useDismissOnOutside", () => {
  it("closes on a mousedown outside the root, not inside it", () => {
    const { wrapper, close } = mountHost()
    mousedown(wrapper.get("button").element)
    expect(close).not.toHaveBeenCalled()
    mousedown(document.body)
    expect(close).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it("stops listening once unmounted", () => {
    const { wrapper, close } = mountHost()
    wrapper.unmount()
    mousedown(document.body)
    expect(close).not.toHaveBeenCalled()
  })
})
