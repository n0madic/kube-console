import { mount } from "@vue/test-utils"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"

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

  // Regression: the follow watcher keyed on `lines.length`, but useLogsStream
  // caps the buffer at MAX_LINES — past the cap every flush hands over a NEW
  // array of the SAME length, so the watcher stopped firing and Follow silently
  // froze while lines kept arriving. Identity is the signal, not length.
  it("keeps following when a full buffer is replaced with a same-length array", async () => {
    const first = Array.from({ length: 100 }, (_, i) => `a${i}`)
    const second = Array.from({ length: 100 }, (_, i) => `b${i}`)

    // @tanstack/vue-virtual's default scroll function calls
    // scrollElement.scrollTo(), so counting those counts the scrolls.
    async function scrollsAfterSameLengthUpdate(follow: boolean): Promise<number> {
      const wrapper = mount(LogViewer, { props: { lines: first, follow } })
      const scrollTo = vi.fn()
      ;(wrapper.element as HTMLElement).scrollTo = scrollTo as unknown as HTMLElement["scrollTo"]
      await wrapper.setProps({ lines: second }) // same length, new content
      await nextTick()
      return scrollTo.mock.calls.length
    }

    // The virtualizer adjusts on its own either way; only the follow watcher
    // adds the scroll-to-bottom on top of that. It has to still fire when the
    // length does not change: useLogsStream caps the buffer at MAX_LINES, so
    // past the cap every flush hands over a NEW array of the SAME length — a
    // length-keyed watcher stopped firing exactly there and Follow silently
    // froze while lines kept arriving.
    expect(await scrollsAfterSameLengthUpdate(true)).toBeGreaterThan(
      await scrollsAfterSameLengthUpdate(false),
    )
  })
})
