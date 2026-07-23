import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

import GaugeCard from "@/components/metrics/GaugeCard.vue"

const routerLinkStub = { RouterLink: { props: ["to"], template: "<a><slot /></a>" } }

describe("GaugeCard", () => {
  it("renders the title, detail line and percentage, plus a progress ring", () => {
    const wrapper = mount(GaugeCard, {
      props: { title: "CPU Usage", detail: "0.82 / 8 cores", percent: 10.3 },
    })
    expect(wrapper.text()).toContain("CPU Usage")
    expect(wrapper.text()).toContain("0.82 / 8 cores")
    expect(wrapper.text()).toContain("10.3 %")
    // Track + progress arc.
    expect(wrapper.findAll("circle").length).toBe(2)
    expect(wrapper.element.tagName.toLowerCase()).toBe("section")
  })

  it("shows a dash and only the track ring when the value is unknown", () => {
    const wrapper = mount(GaugeCard, {
      props: { title: "CPU Usage", detail: "— / 8 cores", percent: null },
    })
    expect(wrapper.text()).toContain("—")
    expect(wrapper.findAll("circle").length).toBe(1)
  })

  it("colors the usage ring by threshold (sky → amber → rose)", () => {
    expect(mount(GaugeCard, { props: { title: "t", detail: "d", percent: 10 } }).html()).toContain(
      "text-sky-500",
    )
    expect(mount(GaugeCard, { props: { title: "t", detail: "d", percent: 80 } }).html()).toContain(
      "text-amber-500",
    )
    expect(mount(GaugeCard, { props: { title: "t", detail: "d", percent: 95 } }).html()).toContain(
      "text-rose-500",
    )
  })

  it("colors the health ring green only when fully ready", () => {
    const full = mount(GaugeCard, {
      props: { title: "Nodes", detail: "2 / 2 Ready", percent: 100, variant: "health" },
    })
    expect(full.html()).toContain("text-emerald-500")
    const degraded = mount(GaugeCard, {
      props: { title: "Nodes", detail: "1 / 2 Ready", percent: 50, variant: "health" },
    })
    expect(degraded.html()).toContain("text-amber-500")
  })

  it("renders as a link when a route is provided", () => {
    const wrapper = mount(GaugeCard, {
      props: { title: "Pods", detail: "3 / 4", percent: 75, to: { name: "resource-list" } },
      global: { stubs: routerLinkStub },
    })
    expect(wrapper.find("a").exists()).toBe(true)
  })
})
