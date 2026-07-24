// jsdom has no layout engine, so the chart itself cannot be exercised here.
// What this pins is the one class the whole resize path hangs on, verified in a
// real browser: without it the card, being a grid item whose content is a
// pixel-sized uPlot root, never shrinks below the canvas already drawn — the
// container stays wide, the ResizeObserver never fires and the chart keeps the
// width it had before the window (or the sidebar) took it away. Measured: at a
// 644px container the card stayed 934px.

import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"

// The real uPlot draws from a queued frame that outlives the test and dies on
// jsdom's missing canvas (`clearRect` of a null 2d context, then `Path2D`) as an
// unhandled error rather than a failure. Stubbing the canvas API to keep it
// happy would be a lot of scaffolding for a component this test does not render
// anything of — the chart is a black box here, so it is the black box that is
// replaced. Only what MetricsChart calls on it is implemented.
vi.mock("uplot", () => ({
  default: class {
    setSize(): void {}
    setData(): void {}
    destroy(): void {}
  },
}))

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
    wrapper.unmount()
  })
})
