import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h, nextTick, ref, shallowRef, type Ref, type ShallowRef } from "vue"

vi.mock("@/utils/logSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/logSearch")>()
  return { ...actual, scanLines: vi.fn(actual.scanLines) }
})

import { useLogSearch } from "@/composables/useLogSearch"
import { scanLines } from "@/utils/logSearch"

const scanSpy = vi.mocked(scanLines)

const DEBOUNCE_MS = 150

interface Harness {
  search: ReturnType<typeof useLogSearch>
  lines: ShallowRef<string[]>
  version: Ref<number>
  dropped: Ref<number>
  unmount: () => void
}

function useInHost(initial: string[]): Harness {
  const lines = shallowRef<string[]>(initial)
  const version = ref(0)
  const dropped = ref(0)
  let search!: ReturnType<typeof useLogSearch>
  const Host = defineComponent({
    setup() {
      search = useLogSearch(lines, version, dropped)
      return () => h("div")
    },
  })
  const wrapper = mount(Host)
  return { search, lines, version, dropped, unmount: () => wrapper.unmount() }
}

/** Types a query and lets the debounce and the scan watch settle. */
async function type(h: Harness, query: string): Promise<void> {
  h.search.query.value = query
  // The query watch arms the debounce on the next flush, not synchronously.
  await nextTick()
  vi.advanceTimersByTime(DEBOUNCE_MS)
  await nextTick()
}

/** What a flush does: mutate in place, then bump the counter. */
async function flush(h: Harness): Promise<void> {
  h.version.value++
  await nextTick()
}

describe("useLogSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    scanSpy.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("debounces the query before compiling it", async () => {
    const h = useInHost(["hit", "miss"])
    h.search.query.value = "hit"
    await nextTick()
    expect(h.search.compiled.value).toBeNull()
    expect(h.search.matches.value).toEqual([])

    vi.advanceTimersByTime(DEBOUNCE_MS - 1)
    await nextTick()
    expect(h.search.compiled.value).toBeNull()

    vi.advanceTimersByTime(1)
    await nextTick()
    expect(h.search.compiled.value?.source).toBe("hit")
    expect(h.search.matches.value).toEqual([0])
    expect(h.search.active.value).toBeNull()
  })

  it("clears matches and the active position when the query empties", async () => {
    const h = useInHost(["hit"])
    await type(h, "hit")
    h.search.next()
    expect(h.search.active.value).toBe(0)

    await type(h, "   ")
    expect(h.search.compiled.value).toBeNull()
    expect(h.search.matches.value).toEqual([])
    expect(h.search.active.value).toBeNull()
  })

  it("scans only the appended lines on an in-place append", async () => {
    const h = useInHost(["hit 0", "miss"])
    await type(h, "hit")
    expect(h.search.matches.value).toEqual([0])
    scanSpy.mockClear()

    // A line already scanned changes into a match, which an incremental scan
    // must not notice — that is what proves nothing before `from` was re-read.
    h.lines.value[1] = "hit now"
    h.lines.value.push("hit 2", "miss", "hit 4")
    await flush(h)

    expect(h.search.matches.value).toEqual([0, 2, 4])
    expect(scanSpy).toHaveBeenCalledTimes(1)
    expect(scanSpy.mock.calls[0]?.[2]).toBe(2)
  })

  it("hands over a new matches array on every update", async () => {
    const h = useInHost(["hit"])
    await type(h, "hit")
    const before = h.search.matches.value
    h.lines.value.push("hit")
    await flush(h)
    expect(h.search.matches.value).not.toBe(before)
    expect(h.search.matches.value).toEqual([0, 1])
  })

  it("shifts indices and the active position when the head is trimmed", async () => {
    const h = useInHost(["hit a", "miss", "hit b", "miss", "hit c"])
    await type(h, "hit")
    expect(h.search.matches.value).toEqual([0, 2, 4])
    h.search.next()
    h.search.next() // active = 1 → "hit b"
    expect(h.search.active.value).toBe(1)
    scanSpy.mockClear()

    // Exactly what flush() does at the cap: drop the head, append, count.
    h.lines.value.splice(0, 3)
    h.lines.value.push("hit d")
    h.dropped.value += 3
    await flush(h)

    // The buffer is now ["miss", "hit c", "hit d"]: "hit a" and "hit b" fell
    // off the head, "hit c" moved from 4 to 1.
    expect(h.search.matches.value).toEqual([1, 2])
    // The active match was one of the dropped ones, so nothing is selected.
    expect(h.search.active.value).toBeNull()
    // Only the appended tail was scanned.
    expect(scanSpy).toHaveBeenCalledTimes(1)
    expect(scanSpy.mock.calls[0]?.[2]).toBe(2)
  })

  it("keeps the active match selected across a trim that leaves it in place", async () => {
    const h = useInHost(["hit a", "miss", "hit b", "hit c"])
    await type(h, "hit")
    h.search.next()
    h.search.next()
    h.search.next() // active = 2 → "hit c"

    h.lines.value.splice(0, 2)
    h.dropped.value += 2
    await flush(h)

    expect(h.search.matches.value).toEqual([0, 1])
    // "hit a" dropped, so "hit c" moved from position 2 to 1.
    expect(h.search.active.value).toBe(1)
  })

  it("rescans from scratch and resets the position when the array is replaced", async () => {
    const h = useInHost(["hit"])
    await type(h, "hit")
    h.search.next()
    expect(h.search.active.value).toBe(0)
    scanSpy.mockClear()

    // A restart hands over a fresh array with the counter bumped.
    h.lines.value = ["miss", "hit", "hit"]
    await flush(h)

    expect(h.search.matches.value).toEqual([1, 2])
    expect(h.search.active.value).toBeNull()
    expect(scanSpy).toHaveBeenCalledTimes(1)
    expect(scanSpy.mock.calls[0]?.[2] ?? 0).toBe(0)
  })

  it("rescans from scratch when the query changes", async () => {
    const h = useInHost(["a", "b", "ab"])
    await type(h, "a")
    expect(h.search.matches.value).toEqual([0, 2])
    h.search.next()

    await type(h, "b")
    expect(h.search.matches.value).toEqual([1, 2])
    expect(h.search.active.value).toBeNull()
  })

  it("moves through matches with wrap-around and bumps jumpSeq on every move", async () => {
    const h = useInHost(["hit", "miss", "hit"])
    await type(h, "hit")
    const seq0 = h.search.jumpSeq.value

    h.search.next()
    expect(h.search.active.value).toBe(0)
    expect(h.search.jumpSeq.value).toBe(seq0 + 1)
    h.search.next()
    expect(h.search.active.value).toBe(1)
    h.search.next()
    expect(h.search.active.value).toBe(0)
    expect(h.search.jumpSeq.value).toBe(seq0 + 3)

    h.search.prev()
    expect(h.search.active.value).toBe(1)
    h.search.prev()
    expect(h.search.active.value).toBe(0)
    expect(h.search.jumpSeq.value).toBe(seq0 + 5)
  })

  it("starts prev from the last match", async () => {
    const h = useInHost(["hit", "hit", "hit"])
    await type(h, "hit")
    h.search.prev()
    expect(h.search.active.value).toBe(2)
  })

  // With a single match Enter goes 0 → 0; the jump is an event, not a state
  // read, so a second Enter after scrolling away must still re-center it.
  it("bumps jumpSeq even when the active position does not change", async () => {
    const h = useInHost(["hit"])
    await type(h, "hit")
    h.search.next()
    h.search.next()
    expect(h.search.active.value).toBe(0)
    expect(h.search.jumpSeq.value).toBe(2)
  })

  // Enter straight after typing must search for what was typed, not land on
  // the previous query's matches while the debounce is still pending.
  it("applies a pending query on next/prev", async () => {
    const h = useInHost(["a", "b"])
    await type(h, "a")
    expect(h.search.matches.value).toEqual([0])

    h.search.query.value = "b"
    await nextTick() // the debounce is armed, not run
    h.search.next()

    expect(h.search.compiled.value?.source).toBe("b")
    expect(h.search.matches.value).toEqual([1])
    expect(h.search.active.value).toBe(0)
    // The timer was consumed, so nothing fires later either.
    vi.advanceTimersByTime(DEBOUNCE_MS)
    await nextTick()
    expect(h.search.active.value).toBe(0)
  })

  it("does nothing on next/prev with no matches", async () => {
    const h = useInHost(["miss"])
    await type(h, "hit")
    h.search.next()
    h.search.prev()
    expect(h.search.active.value).toBeNull()
    expect(h.search.jumpSeq.value).toBe(0)
  })

  it("only filters with both the checkbox and a query", async () => {
    const h = useInHost(["hit"])
    h.search.filter.value = true
    expect(h.search.filtering.value).toBe(false)
    await type(h, "hit")
    expect(h.search.filtering.value).toBe(true)
    await type(h, "")
    expect(h.search.filtering.value).toBe(false)
  })

  it("clear empties the query and the position but keeps the filter choice", async () => {
    const h = useInHost(["hit"])
    h.search.filter.value = true
    await type(h, "hit")
    h.search.next()

    h.search.clear()
    await nextTick()
    vi.advanceTimersByTime(DEBOUNCE_MS)
    await nextTick()

    expect(h.search.query.value).toBe("")
    expect(h.search.compiled.value).toBeNull()
    expect(h.search.active.value).toBeNull()
    expect(h.search.matches.value).toEqual([])
    expect(h.search.filter.value).toBe(true)
    expect(h.search.filtering.value).toBe(false)
  })

  it("drops a pending debounce on unmount", async () => {
    const h = useInHost(["hit"])
    h.search.query.value = "hit"
    await nextTick()
    h.unmount()
    vi.advanceTimersByTime(DEBOUNCE_MS)
    await nextTick()
    expect(h.search.compiled.value).toBeNull()
  })
})
