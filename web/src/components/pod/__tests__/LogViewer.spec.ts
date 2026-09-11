import { mount } from "@vue/test-utils"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"

import LogViewer from "@/components/pod/LogViewer.vue"
import { compileQuery } from "@/utils/logSearch"

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

  // A scroll is clamped to the scroll element's laid-out height, which is the
  // spacer div sized by the virtualizer in the render. A pre-flush watcher
  // scrolled before that render, so the request was clamped to the previous
  // height: a 500-line tail loaded in one flush stayed at the top (measured
  // against a real apiserver). The spy captures the spacer height at the
  // moment of each scroll, which is what jsdom can observe of the ordering.
  it("scrolls only after the spacer has grown to the new line count", async () => {
    const live = Array.from({ length: 100 }, (_, i) => `d${i}`)
    const wrapper = mount(LogViewer, { props: { lines: live, version: 0, follow: true } })
    const heights: string[] = []
    ;(wrapper.element as HTMLElement).scrollTo = (() => {
      heights.push((wrapper.element.firstElementChild as HTMLElement).style.height)
    }) as unknown as HTMLElement["scrollTo"]

    for (let i = 100; i < 150; i++) live.push(`d${i}`)
    await wrapper.setProps({ version: 1 })
    await nextTick()

    // The virtualizer scrolls on its own as well (see the follow tests); the
    // follow scroll is the last one, and it must see the grown spacer.
    expect(heights.length).toBeGreaterThan(0)
    expect(heights.at(-1)).toBe("3000px")
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

describe("LogViewer search", () => {
  const query = compileQuery("err")!

  function mountWith(props: Record<string, unknown>) {
    const wrapper = mount(LogViewer, {
      props: { lines, version: 0, follow: false, ...props },
    })
    const scrollTo = vi.fn()
    ;(wrapper.element as HTMLElement).scrollTo = scrollTo as unknown as HTMLElement["scrollTo"]
    return { wrapper, scrollTo }
  }

  it("marks hits without changing the rendered text", () => {
    const plain = "an ERROR and an error"
    const { wrapper } = mountWith({ lines: [plain], query, matches: [0] })
    const row = wrapper.get("[data-index='0']")
    const marks = row.findAll("mark")
    expect(marks.map((m) => m.text())).toEqual(["ERR", "err"])
    expect(row.text()).toBe(plain)
    // A plain-text mark must not take the UA stylesheet's black text.
    expect(marks[0]?.classes()).toContain("text-inherit")
  })

  it("marks hits inside a JSON row and keeps the token color", () => {
    const json = '{"level":"error","msg":"boom"}'
    const { wrapper } = mountWith({ lines: [json], query, matches: [0] })
    const row = wrapper.get("[data-index='0']")
    const mark = row.get("mark")
    expect(mark.text()).toBe("err")
    expect(mark.classes()).toContain("text-red-400")
    expect(row.text()).toBe(json)
    // The rest of the token is still colored.
    expect(row.findAll("span").some((s) => s.classes().includes("text-red-400"))).toBe(true)
  })

  it("renders no marks without a query", () => {
    const { wrapper } = mountWith({ lines: ["error"], query: null, matches: [] })
    expect(wrapper.findAll("mark")).toHaveLength(0)
    expect(wrapper.get("[data-index='0']").findAll("span")).toHaveLength(0)
  })

  it("renders only matching lines in filter mode, keyed as the virtualizer expects", () => {
    const all = ["ok 0", "error 1", "ok 2", "error 3", "error 4"]
    const { wrapper } = mountWith({ lines: all, query, matches: [1, 3, 4], filter: true })
    const rows = wrapper.findAll("[data-index]")
    // data-index is the virtualizer's item index (measureElement reads it);
    // data-line is the position in the buffer.
    expect(rows.map((r) => r.attributes("data-index"))).toEqual(["0", "1", "2"])
    expect(rows.map((r) => r.attributes("data-line"))).toEqual(["1", "3", "4"])
    expect(rows.map((r) => r.text())).toEqual(["error 1", "error 3", "error 4"])
  })

  it("highlights the active match row", () => {
    const all = ["error 0", "error 1"]
    const { wrapper } = mountWith({ lines: all, query, matches: [0, 1], activeMatch: 1 })
    expect(wrapper.get("[data-line='1']").classes()).toContain("bg-sky-900/60")
    expect(wrapper.get("[data-line='0']").classes()).not.toContain("bg-sky-900/60")
  })

  it("scrolls to the active match on every jump, even to the same one", async () => {
    const all = Array.from({ length: 100 }, (_, i) => (i === 80 ? "error" : `ok ${i}`))
    const { wrapper, scrollTo } = mountWith({ lines: all, query, matches: [80], activeMatch: 0, jumpSeq: 0 })
    scrollTo.mockClear()

    // Relative counts: virtual-core may scroll more than once per request
    // (it re-adjusts after measuring), so what is asserted is that each bump
    // produced a scroll, not how many calls one scroll takes.
    await wrapper.setProps({ jumpSeq: 1 })
    await nextTick()
    const afterFirst = scrollTo.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    await wrapper.setProps({ jumpSeq: 2 })
    await nextTick()
    expect(scrollTo.mock.calls.length).toBeGreaterThan(afterFirst)
  })

  it("scrolls to the visible row of the active match in filter mode", async () => {
    const all = Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? "error" : `ok ${i}`))
    const matches = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]
    const { wrapper, scrollTo } = mountWith({ lines: all, query, matches, filter: true, activeMatch: 9, jumpSeq: 0 })
    scrollTo.mockClear()
    await wrapper.setProps({ jumpSeq: 1 })
    await nextTick()
    // Ten visible rows fit in the viewport, so the scroll target is near 0 for
    // the filtered list, whereas line 90 unfiltered sits well below the fold.
    expect(scrollTo.mock.calls.length).toBeGreaterThan(0)
    for (const call of scrollTo.mock.calls) {
      const top = (call[0] as { top?: number } | undefined)?.top ?? 0
      expect(top).toBeLessThan(100)
    }
  })

  // Typing a query changes `matches` without a flush; a followed-but-finished
  // stream must not jump to its end while the user reads higher up.
  it("does not auto-scroll a followed stream when only the matches change", async () => {
    const all = Array.from({ length: 100 }, (_, i) => `c${i}`)

    // Relative, like the follow tests above: the virtualizer scrolls on its
    // own either way, and only the follow watcher would add to that.
    async function scrolls(follow: boolean): Promise<number> {
      const { wrapper, scrollTo } = mountWith({ lines: all, follow, query: null, matches: [] })
      scrollTo.mockClear()
      await wrapper.setProps({ query: compileQuery("c1")!, matches: [1, 10, 11] })
      await nextTick()
      return scrollTo.mock.calls.length
    }

    expect(await scrolls(true)).toBe(await scrolls(false))
  })

  // Esc ends the pause; on a quiet stream nothing else would re-anchor the
  // view until the next line arrived.
  it("returns a followed stream to its end when the query is cleared", async () => {
    const all = Array.from({ length: 100 }, (_, i) => (i === 1 ? "error" : `c${i}`))

    async function scrolls(follow: boolean): Promise<number> {
      const { wrapper, scrollTo } = mountWith({ lines: all, follow, query, matches: [1], activeMatch: 0 })
      scrollTo.mockClear()
      await wrapper.setProps({ query: null, matches: [], activeMatch: null })
      await nextTick()
      return scrollTo.mock.calls.length
    }

    expect(await scrolls(true)).toBeGreaterThan(await scrolls(false))
  })

  // Refining the query after Enter also drops the selection (a full rescan),
  // but that is mid-typing, not a resume: the view must stay where it is.
  it("does not re-anchor when a refined query drops the selection", async () => {
    const all = Array.from({ length: 100 }, (_, i) => (i === 1 ? "error" : `c${i}`))

    async function scrolls(follow: boolean): Promise<number> {
      const { wrapper, scrollTo } = mountWith({ lines: all, follow, query, matches: [1], activeMatch: 0 })
      scrollTo.mockClear()
      await wrapper.setProps({ query: compileQuery("erro")!, matches: [1], activeMatch: null })
      await nextTick()
      return scrollTo.mock.calls.length
    }

    expect(await scrolls(true)).toBe(await scrolls(false))
  })

  it("does not auto-scroll a followed stream while a match is active", async () => {
    const first = Array.from({ length: 100 }, (_, i) => `c${i}`)

    async function scrolls(activeMatch: number | null): Promise<number> {
      const live = [...first]
      const { wrapper, scrollTo } = mountWith({
        lines: live,
        follow: true,
        query: compileQuery("c1")!,
        matches: [1],
        activeMatch,
      })
      scrollTo.mockClear()
      live.push("c100")
      await wrapper.setProps({ version: 1 })
      await nextTick()
      expect(rowTexts(wrapper).length).toBeGreaterThan(0)
      return scrollTo.mock.calls.length
    }

    expect(await scrolls(null)).toBeGreaterThan(await scrolls(0))
  })
})
