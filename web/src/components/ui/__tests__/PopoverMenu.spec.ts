import { enableAutoUnmount, mount } from "@vue/test-utils"
import { afterEach, describe, expect, it } from "vitest"
import { nextTick } from "vue"

import PopoverMenu from "@/components/ui/PopoverMenu.vue"

enableAutoUnmount(afterEach)

function mountMenu() {
  return mount(PopoverMenu, {
    props: { label: "Options" },
    slots: { default: '<label><input type="checkbox" /> Wrap</label>' },
    attachTo: document.body,
  })
}

describe("PopoverMenu", () => {
  it("starts closed and toggles on the trigger", async () => {
    const wrapper = mountMenu()
    const trigger = wrapper.get("button")
    expect(wrapper.find("input[type=checkbox]").exists()).toBe(false)
    expect(trigger.attributes("aria-expanded")).toBe("false")

    await trigger.trigger("click")
    expect(wrapper.find("input[type=checkbox]").exists()).toBe(true)
    expect(trigger.attributes("aria-expanded")).toBe("true")
    expect(trigger.attributes("aria-controls")).toBe(
      wrapper.get("input[type=checkbox]").element.closest("div")?.id,
    )

    await trigger.trigger("click")
    expect(wrapper.find("input[type=checkbox]").exists()).toBe(false)
  })

  it("closes on a click outside, not on one inside", async () => {
    const wrapper = mountMenu()
    await wrapper.get("button").trigger("click")

    wrapper.get("input[type=checkbox]").element.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    )
    await nextTick()
    expect(wrapper.find("input[type=checkbox]").exists()).toBe(true)

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    await nextTick()
    expect(wrapper.find("input[type=checkbox]").exists()).toBe(false)
  })

  // The sidebar drawer's Escape handler keys on defaultPrevented; an Escape
  // that closes this panel must not also close the drawer under it.
  it("closes on Escape, consumes it and returns focus to the trigger", async () => {
    const wrapper = mountMenu()
    const trigger = wrapper.get("button")
    await trigger.trigger("click")
    const box = wrapper.get("input[type=checkbox]")
    ;(box.element as HTMLInputElement).focus()

    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    box.element.dispatchEvent(e)
    await nextTick()

    expect(e.defaultPrevented).toBe(true)
    expect(wrapper.find("input[type=checkbox]").exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
  })

  it("names an icon-only trigger through title and aria-label", () => {
    const wrapper = mount(PopoverMenu, {
      props: { label: "Log options", icon: "cog-6-tooth" },
      slots: { default: "<span>x</span>" },
    })
    const trigger = wrapper.get("button")
    expect(trigger.attributes("aria-label")).toBe("Log options")
    expect(trigger.attributes("title")).toBe("Log options")
    expect(trigger.text()).toBe("")
    expect(trigger.find("svg").exists()).toBe(true)
  })

  it("leaves Escape alone while closed", async () => {
    const wrapper = mountMenu()
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    wrapper.get("button").element.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })
})
