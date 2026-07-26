import { mount } from "@vue/test-utils"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"

import LogViewer from "@/components/pod/LogViewer.vue"

// Give the virtualizer a real viewport in jsdom. getBoundingClientRect covers
// the initial mount; virtual-core measures the attached scroll element with
// offsetWidth/offsetHeight (always 0 in jsdom, which has no layout), so those
// need stubbing too or every re-render after mount collapses to zero rows —
// and any post-update row assertion passes vacuously.
const originalGetRect = Element.prototype.getBoundingClientRect
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!
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
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 1024,
  })
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 640,
  })
})
afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetRect
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth)
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight)
})

const lines = ["first line", "second line"]

/** Rendered rows in index order — empty when the virtualizer renders none. */
function rowTexts(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper
    .findAll("[data-index]")
    .map((row) => ({ index: Number(row.attributes("data-index")), text: row.text() }))
    .sort((a, b) => a.index - b.index)
    .map((row) => row.text)
}

describe("LogViewer", () => {
  it("does not wrap by default", () => {
    const wrapper = mount(LogViewer, { props: { lines, version: 0, follow: false } })
    const row = wrapper.get("[data-index='0']")
    expect(row.classes()).toContain("whitespace-pre")
    expect(row.classes()).not.toContain("whitespace-pre-wrap")
    // Fixed-height path keeps the estimated row height.
    expect(row.attributes("style")).toContain("height: 20px")
  })

  it("wraps long lines when wrap is on", () => {
    const wrapper = mount(LogViewer, { props: { lines, version: 0, follow: false, wrap: true } })

    const row = wrapper.get("[data-index='0']")
    expect(row.classes()).toContain("whitespace-pre-wrap")
    expect(row.classes()).toContain("break-all")
    // Measured rows must not be pinned to the estimate.
    expect(row.attributes("style")).not.toContain("height: 20px")
  })

  it("colorizes JSON lines and leaves plain ones untouched", () => {
    const json = '{"level":"error","msg":"boom","n":1}'
    const plain = "starting server on :8080"
    const wrapper = mount(LogViewer, { props: { lines: [json, plain], version: 0, follow: false } })

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

  // Regression: the follow watcher keyed on `lines.length`, but the buffer is
  // capped at MAX_LINES — at the cap the length stops changing while lines keep
  // arriving, so the watcher stopped firing and Follow silently froze. The array
  // is one half of the signal (a restart hands over a fresh one), the version
  // counter the other; neither is the length.
  it("keeps following when a full buffer is replaced with a same-length array", async () => {
    const first = Array.from({ length: 100 }, (_, i) => `a${i}`)
    const second = Array.from({ length: 100 }, (_, i) => `b${i}`)

    // @tanstack/vue-virtual's default scroll function calls
    // scrollElement.scrollTo(), so counting those counts the scrolls.
    async function scrollsAfterSameLengthUpdate(follow: boolean): Promise<number> {
      const wrapper = mount(LogViewer, { props: { lines: first, version: 0, follow } })
      const scrollTo = vi.fn()
      ;(wrapper.element as HTMLElement).scrollTo = scrollTo as unknown as HTMLElement["scrollTo"]
      await wrapper.setProps({ lines: second }) // same length, new content
      await nextTick()
      return scrollTo.mock.calls.length
    }

    // The virtualizer adjusts on its own either way; only the follow watcher
    // adds the scroll-to-bottom on top of that. It has to still fire when the
    // length does not change, since the buffer sitting at MAX_LINES is exactly
    // the case a length-keyed watcher stopped firing on.
    expect(await scrollsAfterSameLengthUpdate(true)).toBeGreaterThan(
      await scrollsAfterSameLengthUpdate(false),
    )
  })

  // `useLogsStream` appends into the SAME array and bumps `version` (copying a
  // 200k-line buffer per flush was quadratic in the lines loaded), so a mutation
  // arrives with neither a new identity nor — at the cap — a new length.
  it("renders lines appended into the same array in place", async () => {
    const live = ["a0", "a1"]
    const wrapper = mount(LogViewer, { props: { lines: live, version: 0, follow: false } })
    expect(rowTexts(wrapper)).toEqual(["a0", "a1"])

    live.push("a2", "a3") // exactly what a flush does
    await wrapper.setProps({ version: 1 })

    const texts = rowTexts(wrapper)
    // The rows must really be there: with no offsetWidth/offsetHeight stub the
    // virtualizer renders none after an update and this would pass on [].
    expect(texts.length).toBeGreaterThan(0)
    expect(texts).toEqual(["a0", "a1", "a2", "a3"])
  })

  // The head is dropped with splice, so the same index holds a different line
  // afterwards — the visible slice has to be re-derived, not just re-positioned.
  it("re-derives visible rows when the head is trimmed in place", async () => {
    const live = ["b0", "b1", "b2"]
    const wrapper = mount(LogViewer, { props: { lines: live, version: 0, follow: false } })
    expect(rowTexts(wrapper)).toEqual(["b0", "b1", "b2"])

    live.splice(0, 2)
    live.push("b3", "b4")
    await wrapper.setProps({ version: 1 })

    const texts = rowTexts(wrapper)
    expect(texts.length).toBeGreaterThan(0)
    expect(texts).toEqual(["b2", "b3", "b4"])
  })

  it("follows an in-place append", async () => {
    const first = Array.from({ length: 100 }, (_, i) => `c${i}`)

    async function scrollsAfterInPlaceAppend(follow: boolean): Promise<number> {
      const live = [...first]
      const wrapper = mount(LogViewer, { props: { lines: live, version: 0, follow } })
      const scrollTo = vi.fn()
      ;(wrapper.element as HTMLElement).scrollTo = scrollTo as unknown as HTMLElement["scrollTo"]
      live.push("c100")
      await wrapper.setProps({ version: 1 })
      await nextTick()
      expect(rowTexts(wrapper).length).toBeGreaterThan(0)
      return scrollTo.mock.calls.length
    }

    expect(await scrollsAfterInPlaceAppend(true)).toBeGreaterThan(
      await scrollsAfterInPlaceAppend(false),
    )
  })
})
