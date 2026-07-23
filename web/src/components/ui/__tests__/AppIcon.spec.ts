import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

import AppIcon from "@/components/ui/AppIcon.vue"
import { ICONS, type IconName } from "@/utils/icons"

describe("AppIcon", () => {
  it("renders an outline glyph with stroke and no fill", () => {
    const svg = mount(AppIcon, { props: { name: "arrow-path" } }).get("svg")
    expect(svg.attributes("viewBox")).toBe("0 0 24 24")
    expect(svg.attributes("fill")).toBe("none")
    expect(svg.attributes("stroke")).toBe("currentColor")
    expect(svg.attributes("stroke-width")).toBe("2")
  })

  it("renders a filled glyph without a stroke", () => {
    const svg = mount(AppIcon, { props: { name: "caret-down" } }).get("svg")
    expect(svg.attributes("viewBox")).toBe("0 0 20 20")
    expect(svg.attributes("fill")).toBe("currentColor")
    expect(svg.attributes("stroke")).toBeUndefined()
    expect(svg.attributes("stroke-width")).toBeUndefined()
  })

  // Sizing and color are the caller's; a default here would fight them and
  // stylesheet order — not class order — would pick the winner.
  it("carries no size of its own and stays out of the accessibility tree", () => {
    const svg = mount(AppIcon, { props: { name: "eye" }, attrs: { class: "h-5 w-5" } }).get("svg")
    expect(svg.classes()).toEqual(["h-5", "w-5"])
    expect(svg.attributes("aria-hidden")).toBe("true")
  })

  it("renders every path of a multi-path glyph", () => {
    const wrapper = mount(AppIcon, { props: { name: "eye" } })
    expect(wrapper.findAll("path")).toHaveLength(ICONS.eye.paths.length)
    expect(ICONS.eye.paths.length).toBeGreaterThan(1)
  })

  it("every registered icon renders a non-empty path", () => {
    for (const name of Object.keys(ICONS) as IconName[]) {
      const paths = mount(AppIcon, { props: { name } }).findAll("path")
      expect(paths.length, name).toBeGreaterThan(0)
      for (const path of paths) expect(path.attributes("d"), name).toBeTruthy()
    }
  })
})
