import { mount } from "@vue/test-utils"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import LogViewer from "@/components/pod/LogViewer.vue"

// Give the virtualizer a real viewport in jsdom.
const originalGetRect = Element.prototype.getBoundingClientRect
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 1024,
      height: 640,
      top: 0,
      left: 0,
      bottom: 640,
      right: 1024,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }
})
afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetRect
})

const lines = ["first line", "second line"]

describe("LogViewer", () => {
  it("does not wrap by default", () => {
    const wrapper = mount(LogViewer, { props: { lines, follow: false } })
    const row = wrapper.get("[data-index='0']")
    expect(row.classes()).toContain("whitespace-pre")
    expect(row.classes()).not.toContain("whitespace-pre-wrap")
    // Fixed-height path keeps the estimated row height.
    expect(row.attributes("style")).toContain("height: 20px")
  })

  it("wraps long lines when wrap is on", () => {
    const wrapper = mount(LogViewer, { props: { lines, follow: false, wrap: true } })

    const row = wrapper.get("[data-index='0']")
    expect(row.classes()).toContain("whitespace-pre-wrap")
    expect(row.classes()).toContain("break-all")
    // Measured rows must not be pinned to the estimate.
    expect(row.attributes("style")).not.toContain("height: 20px")
  })

  it("colorizes JSON lines and leaves plain ones untouched", () => {
    const json = '{"level":"error","msg":"boom","n":1}'
    const plain = "starting server on :8080"
    const wrapper = mount(LogViewer, { props: { lines: [json, plain], follow: false } })

    const jsonRow = wrapper.get("[data-index='0']")
    const spans = jsonRow.findAll("span")
    expect(spans.length).toBeGreaterThan(1)
    expect(spans.some((s) => s.classes().includes("text-red-400"))).toBe(true)
    // Coloring must not alter the rendered text — no injected whitespace.
    expect(jsonRow.text()).toBe(json)

    const plainRow = wrapper.get("[data-index='1']")
    expect(plainRow.findAll("span")).toHaveLength(0)
    expect(plainRow.text()).toBe(plain)
  })
})
