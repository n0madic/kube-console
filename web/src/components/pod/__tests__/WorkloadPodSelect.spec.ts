import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

import WorkloadPodSelect from "@/components/pod/WorkloadPodSelect.vue"
import type { PodChoice } from "@/utils/ownedPods"

function choice(name: string, status = "Running"): PodChoice {
  return { name, status, createdMs: 0 }
}

function mountSelect(choices: PodChoice[], truncated = false, modelValue = choices[0]?.name ?? "") {
  return mount(WorkloadPodSelect, { props: { choices, truncated, modelValue } })
}

describe("WorkloadPodSelect", () => {
  // One pod is not a choice: the control keeps its shape (the toolbar does
  // not lose its first slot) but cannot be opened, and says why.
  it("locks itself, visibly, with a single pod", () => {
    const wrapper = mountSelect([choice("web-1")])

    expect(wrapper.get("select").attributes("disabled")).toBeDefined()
    expect(wrapper.get("label").classes()).toContain("opacity-60")
    expect(wrapper.get("label").attributes("title")).toBe("The only pod")
    // The select is what the pointer lands on, and its own title (the full
    // pick, see below) must not hide the reason.
    expect(wrapper.get("select").attributes("title")).toBe("web-1 · Running — the only pod")
  })

  it("stays open with more than one pod", () => {
    const wrapper = mountSelect([choice("web-1"), choice("web-2")])

    expect(wrapper.get("select").attributes("disabled")).toBeUndefined()
    expect(wrapper.get("label").attributes("title")).toBeUndefined()
    expect(wrapper.findAll("option").map((o) => o.attributes("value"))).toEqual(["web-1", "web-2"])
  })

  it("names each option with its status, or the name alone without one", () => {
    const wrapper = mountSelect([choice("web-1", "CrashLoopBackOff"), choice("web-2", "")])

    expect(wrapper.findAll("option").map((o) => o.text())).toEqual([
      "web-1 · CrashLoopBackOff",
      "web-2",
    ])
  })

  it("marks a truncated scan with a disabled trailing option", () => {
    const wrapper = mountSelect([choice("web-1"), choice("web-2")], true)

    const marker = wrapper.get('option[value="__truncated__"]')
    expect(marker.attributes("disabled")).toBeDefined()
    expect(marker.text()).toContain("more pods not listed")
    expect(wrapper.findAll("option").at(-1)?.element).toBe(marker.element)
  })

  // A native select is as wide as its longest option, and a generated pod
  // name with its status pushed the log toolbar's search group onto a second
  // line at ordinary laptop widths — so the control is capped and ellipsized,
  // with the full text of the pick in its title.
  it("caps its width and carries the full pick in the title", async () => {
    const wrapper = mountSelect([choice("web-1", "CrashLoopBackOff"), choice("web-2")])
    const select = wrapper.get("select")
    expect(select.classes()).toContain("max-w-[14rem]")
    expect(select.classes()).toContain("truncate")
    expect(select.attributes("title")).toBe("web-1 · CrashLoopBackOff")

    await wrapper.setProps({ modelValue: "web-2" })
    expect(select.attributes("title")).toBe("web-2 · Running")
  })
})
