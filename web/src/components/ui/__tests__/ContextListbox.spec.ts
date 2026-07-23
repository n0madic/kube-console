import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

import ContextListbox from "@/components/ui/ContextListbox.vue"

const items = [
  { name: "dev", signedIn: false },
  { name: "prod", signedIn: true },
  { name: "staging", signedIn: false },
]

function mountListbox(selected = "prod") {
  return mount(ContextListbox, { props: { items, selected } })
}

describe("ContextListbox", () => {
  // The trigger keeps the focus while the panel is open, so the highlighted
  // option is only conveyed by aria-activedescendant.
  it("points aria-activedescendant at the highlighted option", async () => {
    const wrapper = mountListbox()
    const trigger = wrapper.get("button")
    expect(trigger.attributes("aria-activedescendant")).toBeUndefined()

    await trigger.trigger("click")
    const options = wrapper.findAll("[role='option']")
    // Opening highlights the selected context, not the first one.
    expect(trigger.attributes("aria-activedescendant")).toBe(options[1]!.attributes("id"))

    await wrapper.get("[role='combobox']").trigger("keydown", { key: "ArrowDown" })
    expect(trigger.attributes("aria-activedescendant")).toBe(options[2]!.attributes("id"))
  })

  it("links the trigger to the popup only while it is open", async () => {
    const wrapper = mountListbox()
    const trigger = wrapper.get("button")
    expect(trigger.attributes("aria-controls")).toBeUndefined()
    expect(trigger.attributes("aria-expanded")).toBe("false")

    await trigger.trigger("click")
    expect(trigger.attributes("aria-expanded")).toBe("true")
    expect(trigger.attributes("aria-controls")).toBe(wrapper.get("[role='listbox']").attributes("id"))
  })

  // Two pickers can share a document; a shared id would make
  // aria-activedescendant resolve to the wrong instance's option. `useId` is
  // unique per app, so both instances must be mounted in the same one — two
  // separate mount() calls each get their own app and their own counter.
  it("scopes the option ids per instance", async () => {
    const wrapper = mount(
      {
        components: { ContextListbox },
        setup: () => ({ items }),
        template: `<div>
          <ContextListbox :items="items" selected="prod" />
          <ContextListbox :items="items" selected="dev" />
        </div>`,
      },
      { global: { components: { ContextListbox } } },
    )
    const [first, second] = wrapper.findAllComponents(ContextListbox)
    await first!.get("button").trigger("click")
    await second!.get("button").trigger("click")

    const ids = first!.findAll("[role='option']").map((o) => o.attributes("id"))
    const otherIds = second!.findAll("[role='option']").map((o) => o.attributes("id"))
    expect(ids.every((id) => id !== undefined && id !== "")).toBe(true)
    expect(ids.filter((id) => otherIds.includes(id))).toEqual([])
    // And each trigger points into its own popup.
    expect(first!.get("button").attributes("aria-activedescendant")).toBe(ids[1])
    expect(second!.get("button").attributes("aria-activedescendant")).toBe(otherIds[0])
  })

  it("emits the picked name and closes", async () => {
    const wrapper = mountListbox()
    await wrapper.get("button").trigger("click")
    await wrapper.findAll("[role='option']")[0]!.trigger("click")

    expect(wrapper.emitted("select")).toEqual([["dev"]])
    expect(wrapper.findAll("[role='option']")).toHaveLength(0)
  })
})
