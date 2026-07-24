// jsdom has no layout engine, so the chart itself cannot be exercised here
// (uPlot's canvas calls are stubs). What this pins is the one class the whole
// resize path hangs on, verified in a real browser: without it the card, being
// a grid item whose content is a pixel-sized uPlot root, never shrinks below
// the canvas already drawn — the container stays wide, the ResizeObserver never
// fires and the chart keeps the width it had before the window (or the sidebar)
// took it away. Measured: at a 644px container the card stayed 934px.

import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

import MetricsChart from "@/components/metrics/MetricsChart.vue"

describe("MetricsChart", () => {
  it("lets its card shrink with the container", () => {
    const wrapper = mount(MetricsChart, {
      props: {
        title: "CPU usage",
        unit: "cpu",
        labels: ["total"],
        data: [
          [1, 2],
          [0.5, 0.7],
        ],
      },
    })

    expect(wrapper.get("section").classes()).toContain("min-w-0")
  })
})
