import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"

import { usePollingLoop, type PollingLoop } from "@/composables/usePollingLoop"

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden })
}

function fireVisibilityChange(hidden: boolean): void {
  setHidden(hidden)
  document.dispatchEvent(new Event("visibilitychange"))
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

interface Harness {
  loop: PollingLoop
  ticks: number[]
  onStop: ReturnType<typeof vi.fn>
  unmount: () => void
}

function mountLoop(
  tick: (gen: number, loop: () => PollingLoop) => Promise<void> | void = () => {},
  intervalMs = 1000,
): Harness {
  const ticks: number[] = []
  const onStop = vi.fn()
  let loop!: PollingLoop
  const Host = defineComponent({
    setup() {
      loop = usePollingLoop(
        (gen) => {
          ticks.push(gen)
          return tick(gen, () => loop)
        },
        () => intervalMs,
        onStop,
      )
      return () => h("div")
    },
  })
  const wrapper = mount(Host)
  return { loop, ticks, onStop, unmount: () => wrapper.unmount() }
}

describe("usePollingLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setHidden(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    setHidden(false)
  })

  it("polls immediately on start and then every interval", async () => {
    const h = mountLoop(() => {}, 1000)
    await h.loop.start()
    expect(h.ticks.length).toBe(1) // immediate poll

    await vi.advanceTimersByTimeAsync(3000)
    expect(h.ticks.length).toBe(4) // + three scheduled polls
    h.loop.stop()
  })

  it("marks the generation current only while live", async () => {
    const h = mountLoop()
    let genDuringTick = -1
    const h2 = mountLoop((gen) => {
      genDuringTick = gen
    })
    await h2.loop.start()
    expect(h2.loop.isCurrent(genDuringTick)).toBe(true)
    h2.loop.stop()
    expect(h2.loop.isCurrent(genDuringTick)).toBe(false)
    h.loop.stop()
  })

  it("stops scheduling after stop()", async () => {
    const h = mountLoop()
    await h.loop.start()
    const afterStart = h.ticks.length
    h.loop.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.ticks.length).toBe(afterStart) // no further polls
    expect(h.onStop).toHaveBeenCalled()
  })

  it("does not enter the loop when the gate returns false", async () => {
    const addSpy = vi.spyOn(document, "addEventListener")
    const h = mountLoop()
    await h.loop.start(() => false)
    expect(h.ticks.length).toBe(0)
    expect(addSpy.mock.calls.some(([type]) => type === "visibilitychange")).toBe(false)
    addSpy.mockRestore()
  })

  it("enters the loop when the gate returns true", async () => {
    const h = mountLoop()
    await h.loop.start(() => true)
    expect(h.ticks.length).toBe(1)
    h.loop.stop()
  })

  it("skips scheduled polls while hidden but resumes when visible", async () => {
    const h = mountLoop()
    await h.loop.start()
    const afterStart = h.ticks.length

    setHidden(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.ticks.length).toBe(afterStart) // no polls while hidden

    setHidden(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.ticks.length).toBe(afterStart + 1) // loop stayed armed
    h.loop.stop()
  })

  it("polls immediately when the tab becomes visible again", async () => {
    const h = mountLoop()
    await h.loop.start()
    const afterStart = h.ticks.length

    fireVisibilityChange(false) // visible → catch-up poll
    await flush()
    expect(h.ticks.length).toBe(afterStart + 1)
    h.loop.stop()
  })

  it("stops on unmount", async () => {
    const h = mountLoop()
    await h.loop.start()
    const afterStart = h.ticks.length
    h.unmount()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.ticks.length).toBe(afterStart)
    expect(h.onStop).toHaveBeenCalled()
  })
})
