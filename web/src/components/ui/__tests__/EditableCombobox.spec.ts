import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

import EditableCombobox from "@/components/ui/EditableCombobox.vue"

const options = [
  { value: "/bin/sh -c 'exec bash; exec sh'", label: "Auto", hint: "bash when present" },
  { value: "/bin/bash", label: "/bin/bash" },
  { value: "/bin/ash", label: "/bin/ash" },
]

function mountBox(modelValue = options[0]!.value) {
  return mount(EditableCombobox, { props: { options, modelValue, label: "Command" } })
}

describe("EditableCombobox", () => {
  // The bug this control exists for: a datalist filters its options by what
  // the field already holds, so a prefilled field showed one suggestion.
  it("offers every option regardless of what the field holds", async () => {
    const wrapper = mountBox("/bin/bash")
    await wrapper.get("button").trigger("click")

    expect(wrapper.findAll("[role='option']").map((o) => o.text())).toHaveLength(options.length)
  })

  // The auto shell is a `sh -c` one-liner: shown verbatim it fills the toolbar,
  // so an unfocused field shows the option's label instead.
  it("shows the option label until the field is focused", async () => {
    const wrapper = mountBox()
    const input = wrapper.get("input")
    expect(input.element.value).toBe("Auto")
    // The real command is never hidden from a pointer or a screen reader.
    expect(input.attributes("title")).toBe(options[0]!.value)

    await input.trigger("focus")
    expect(input.element.value).toBe(options[0]!.value)

    await input.trigger("blur")
    expect(input.element.value).toBe("Auto")
  })

  it("shows a value that matches no option as itself", () => {
    const wrapper = mountBox("/bin/zsh -l")

    expect(wrapper.get("input").element.value).toBe("/bin/zsh -l")
  })

  it("stays editable: typing updates the model without picking anything", async () => {
    const wrapper = mountBox()
    await wrapper.get("input").setValue("/bin/zsh -l")

    expect(wrapper.props("modelValue")).toBe("/bin/sh -c 'exec bash; exec sh'")
    expect(wrapper.emitted("update:modelValue")).toEqual([["/bin/zsh -l"]])
    // Typing is not picking: the popup never opened.
    expect(wrapper.findAll("[role='option']")).toHaveLength(0)
  })

  it("puts the picked option into the field and closes", async () => {
    const wrapper = mountBox()
    await wrapper.get("button").trigger("click")
    await wrapper.findAll("[role='option']")[1]!.trigger("click")

    expect(wrapper.emitted("update:modelValue")).toEqual([["/bin/bash"]])
    expect(wrapper.findAll("[role='option']")).toHaveLength(0)
  })

  it("opens with ArrowDown and picks with Enter, starting from the current value", async () => {
    const wrapper = mountBox("/bin/bash")
    const input = wrapper.get("input")

    await input.trigger("keydown", { key: "ArrowDown" })
    // Opening highlights the option the field already holds, not the first one.
    const ids = wrapper.findAll("[role='option']").map((o) => o.attributes("id"))
    expect(input.attributes("aria-activedescendant")).toBe(ids[1])

    await input.trigger("keydown", { key: "ArrowDown" })
    await input.trigger("keydown", { key: "Enter" })
    expect(wrapper.emitted("update:modelValue")).toEqual([["/bin/ash"]])
  })

  // Enter must reach the surrounding form when there is nothing to pick.
  it("leaves Enter alone while the popup is closed", async () => {
    const wrapper = mountBox()
    await wrapper.get("input").trigger("keydown", { key: "Enter" })

    expect(wrapper.emitted("update:modelValue")).toBeUndefined()
  })

  it("links the input to the popup only while it is open", async () => {
    const wrapper = mountBox()
    const input = wrapper.get("input")
    expect(input.attributes("aria-expanded")).toBe("false")
    expect(input.attributes("aria-controls")).toBeUndefined()

    await wrapper.get("button").trigger("click")
    expect(input.attributes("aria-expanded")).toBe("true")
    expect(input.attributes("aria-controls")).toBe(wrapper.get("[role='listbox']").attributes("id"))

    await input.trigger("keydown", { key: "Escape" })
    expect(input.attributes("aria-expanded")).toBe("false")
  })

  // Two comboboxes can share a document; a shared id would make
  // aria-activedescendant resolve into the wrong instance's popup.
  it("scopes the option ids per instance", async () => {
    const wrapper = mount(
      {
        components: { EditableCombobox },
        setup: () => ({ options }),
        template: `<div>
          <EditableCombobox :options="options" model-value="/bin/bash" label="A" />
          <EditableCombobox :options="options" model-value="/bin/ash" label="B" />
        </div>`,
      },
      { global: { components: { EditableCombobox } } },
    )
    const [first, second] = wrapper.findAllComponents(EditableCombobox)
    await first!.get("button").trigger("click")
    await second!.get("button").trigger("click")

    const ids = first!.findAll("[role='option']").map((o) => o.attributes("id"))
    const otherIds = second!.findAll("[role='option']").map((o) => o.attributes("id"))
    expect(ids.every((id) => id !== undefined && id !== "")).toBe(true)
    expect(ids.filter((id) => otherIds.includes(id))).toEqual([])
  })

  it("disables the field and the popup toggle together", async () => {
    const wrapper = mountBox()
    await wrapper.setProps({ disabled: true })

    expect(wrapper.get("input").attributes("disabled")).toBeDefined()
    await wrapper.get("button").trigger("click")
    expect(wrapper.findAll("[role='option']")).toHaveLength(0)
  })

  // Being locked has to be visible: an undimmed field that ignores clicks
  // reads as a broken one.
  it("looks disabled, not just behaves disabled", async () => {
    const wrapper = mountBox()
    const field = () => wrapper.get("input").element.parentElement!.className

    expect(field()).not.toContain("opacity-60")
    await wrapper.setProps({ disabled: true })
    expect(field()).toContain("opacity-60")
    expect(field()).toContain("cursor-not-allowed")
  })
})
