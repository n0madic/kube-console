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

  it("paints a trouble segment inside the fill and labels it", () => {
    const wrapper = mount(GaugeCard, {
      props: {
        title: "Pods",
        detail: "31 / 220",
        percent: 14,
        alertPercent: 5,
        alertLabel: "11 in trouble",
      },
    })
    expect(wrapper.text()).toContain("11 in trouble")
    const arcs = wrapper.findAll("circle")
    expect(arcs.length).toBe(3) // track + fill + trouble
    expect(arcs[1]?.attributes("stroke-dasharray")).toBe("14 86")
    expect(arcs[2]?.attributes("stroke-dasharray")).toBe("5 95")
    // Closing the fill (14%), not cutting into its start.
    expect(arcs[2]?.attributes("stroke-dashoffset")).toBe("-9")
    expect(arcs[2]?.classes()).toContain("text-rose-500")
  })

  it("never lets the trouble segment outgrow the fill it sits in", () => {
    const wrapper = mount(GaugeCard, {
      props: { title: "Pods", detail: "1 / 100", percent: 1, alertPercent: 1 },
    })
    // The 2% visibility floor is capped by the 1% fill.
    expect(wrapper.findAll("circle")[2]?.attributes("stroke-dasharray")).toBe("1 99")
  })

  it("draws no trouble segment without a count", () => {
    for (const alertPercent of [null, 0]) {
      const wrapper = mount(GaugeCard, {
        props: { title: "Pods", detail: "31 / 220", percent: 14, alertPercent },
      })
      expect(wrapper.findAll("circle").length).toBe(2)
    }
  })

  it("renders as a link when a route is provided", () => {
    const wrapper = mount(GaugeCard, {
      props: { title: "Pods", detail: "3 / 4", percent: 75, to: { name: "resource-list" } },
      global: { stubs: routerLinkStub },
    })
    expect(wrapper.find("a").exists()).toBe(true)
  })
})
