import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { h } from "vue"

import BaseSelect from "@/components/ui/BaseSelect.vue"

function mountSelect(
  props: { modelValue: unknown } & Record<string, unknown>,
  options: Array<[unknown, string]>,
) {
  return mount(BaseSelect, {
    props,
    slots: { default: () => options.map(([value, text]) => h("option", { value }, text)) },
  })
}

describe("BaseSelect", () => {
  // The whole point of the component: a native select whose arrow is the app's
  // own `caret-down`, so it matches the hand-built pickers beside it.
  it("suppresses the native arrow and draws caret-down over the select", () => {
    const wrapper = mountSelect({ modelValue: "a" }, [["a", "A"]])

    expect(wrapper.get("select").classes()).toContain("appearance-none")
    const icon = wrapper.get("svg")
    expect(icon.attributes("viewBox")).toBe("0 0 20 20")
    expect(icon.classes()).toContain("pointer-events-none")
  })

  // NamespaceSelector's <label for="ns-select"> points at the select itself,
  // so attributes must not settle on the positioning wrapper (inheritAttrs:
  // false). Dropping that would break the label association silently.
  it("puts caller attributes on the select, not on the wrapper", () => {
    const wrapper = mountSelect({ modelValue: "a", id: "ns-select", class: "text-sm" }, [["a", "A"]])

    const select = wrapper.get("select")
    expect(select.attributes("id")).toBe("ns-select")
    expect(select.classes()).toContain("text-sm")
    // …and its own styling survives the merge.
    expect(select.classes()).toContain("rounded-md")
    expect(wrapper.element.getAttribute("id")).toBeNull()
    expect(wrapper.element.className).not.toContain("text-sm")
  })

  it("passes disabled through to the select", () => {
    expect(
      mountSelect({ modelValue: "a", disabled: true }, [["a", "A"]])
        .get("select")
        .attributes("disabled"),
    ).toBeDefined()
    expect(
      mountSelect({ modelValue: "a" }, [["a", "A"]]).get("select").attributes("disabled"),
    ).toBeUndefined()
  })

  // Generic over the model type: the callers bind numbers (poll interval) and
  // a "all" | number union (log tail), and a select that stringified them
  // would break both.
  it("round-trips non-string option values", async () => {
    const wrapper = mountSelect({ modelValue: 500 }, [
      [100, "100"],
      [500, "500"],
      ["all", "All"],
    ])

    await wrapper.get("select").setValue("100")
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([100])

    await wrapper.get("select").setValue("all")
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["all"])
  })
})
