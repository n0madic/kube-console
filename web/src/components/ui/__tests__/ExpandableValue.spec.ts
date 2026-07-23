import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

import ExpandableValue from "@/components/ui/ExpandableValue.vue"

describe("ExpandableValue", () => {
  it("shows short values in full without an expand control", () => {
    const wrapper = mount(ExpandableValue, { props: { value: "short", threshold: 10 } })
    expect(wrapper.find("pre").text()).toBe("short")
    expect(wrapper.find("button").exists()).toBe(false)
  })

  it("truncates long values and toggles full text on expand/collapse", async () => {
    const value = "x".repeat(50)
    const wrapper = mount(ExpandableValue, { props: { value, threshold: 10 } })

    expect(wrapper.find("pre").text()).toBe(`${"x".repeat(10)}…`)
    const button = wrapper.find("button")
    expect(button.text()).toBe("expand (50 chars)")

    await button.trigger("click")
    expect(wrapper.find("pre").text()).toBe(value)
    expect(wrapper.find("button").text()).toBe("collapse")

    await wrapper.find("button").trigger("click")
    expect(wrapper.find("pre").text()).toBe(`${"x".repeat(10)}…`)
  })
})
