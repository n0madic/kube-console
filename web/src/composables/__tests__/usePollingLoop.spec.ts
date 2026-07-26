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

  it("polls immediately when the tab becomes visible after a full interval away", async () => {
    const h = mountLoop()
    await h.loop.start()
    const afterStart = h.ticks.length

    setHidden(true)
    await vi.advanceTimersByTimeAsync(2000) // away for two intervals, no polls
    expect(h.ticks.length).toBe(afterStart)

    fireVisibilityChange(false) // visible → catch-up poll
    await flush()
    expect(h.ticks.length).toBe(afterStart + 1)
    h.loop.stop()
  })

  // Regression: the catch-up ran on every hidden→visible transition, bypassing
  // intervalMs entirely — ten alt-tabs in ten seconds issued ten full polls,
  // which for ProblemPodsCard is ten cluster-wide pod walks against a cadence
  // deliberately set to 60s.
  it("does not re-poll on a visibility flip inside the interval", async () => {
    const h = mountLoop()
    await h.loop.start()
    const afterStart = h.ticks.length

    for (let i = 0; i < 5; i++) {
      fireVisibilityChange(true)
      fireVisibilityChange(false)
      await flush()
    }
    expect(h.ticks.length).toBe(afterStart)

    // And the loop is still armed on its own cadence, not stalled by the skip.
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.ticks.length).toBe(afterStart + 1)
    h.loop.stop()
  })

  // The catch-up replaces the pending timer instead of running beside it: the
  // next scheduled poll must be one interval after the catch-up, not after the
  // poll it superseded.
  it("re-arms the interval from the catch-up poll", async () => {
    const h = mountLoop()
    await h.loop.start()
    const afterStart = h.ticks.length

    setHidden(true)
    await vi.advanceTimersByTimeAsync(1500) // mid-cycle: 500ms left on the timer
    fireVisibilityChange(false)
    await flush()
    expect(h.ticks.length).toBe(afterStart + 1) // the catch-up

    await vi.advanceTimersByTimeAsync(600) // past the old timer's 500ms
    expect(h.ticks.length).toBe(afterStart + 1)
    await vi.advanceTimersByTimeAsync(400) // a full interval after the catch-up
    expect(h.ticks.length).toBe(afterStart + 2)
    h.loop.stop()
  })

  // Regression: lastTickMs is stamped when a poll *starts*, so a tick that
  // outlasts the interval passes the catch-up throttle while still in flight;
  // clearTimer() then no-ops (the armed timer id has already fired) and a
  // second runTick started with the SAME generation — both `.finally` handlers
  // scheduled, and the chain stayed doubled until stop(). Every other test here
  // uses a synchronous tick, which can never be in flight when the flip lands.
  it("does not start a second chain when a visibility flip lands during a long tick", async () => {
    let slowOnce = true
    const h = mountLoop(() => {
      if (!slowOnce) return undefined
      slowOnce = false
      return new Promise<void>((resolve) => setTimeout(resolve, 2500))
    }, 1000)

    const started = h.loop.start() // tick #1 runs t=0..2500
    await flush()
    expect(h.ticks.length).toBe(1)

    // t=1200: a full interval past the tick's start, so the throttle passes —
    // but the tick itself is still in flight.
    await vi.advanceTimersByTimeAsync(1200)
    fireVisibilityChange(true)
    fireVisibilityChange(false)
    await flush()
    expect(h.ticks.length).toBe(1)

    // t=1800: a second flip during the same in-flight tick.
    await vi.advanceTimersByTimeAsync(600)
    fireVisibilityChange(true)
    fireVisibilityChange(false)
    await flush()
    expect(h.ticks.length).toBe(1)

    await vi.advanceTimersByTimeAsync(700) // t=2500: tick #1 completes, re-arms
    await started
    expect(h.ticks.length).toBe(1)

    // Exactly one chain remains: one poll per interval from the completion.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.ticks.length).toBe(11)
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

  // Regression: `start()` awaited the first tick unguarded, so a tick that
  // rejected skipped schedule() and left the loop with nothing armed — silently,
  // since every caller does `void loop.start()`. Polling then stayed dead until
  // the component remounted.
  it("stays armed when the first poll rejects", async () => {
    let first = true
    const h = mountLoop(() => {
      if (first) {
        first = false
        return Promise.reject(new Error("boom"))
      }
      return Promise.resolve()
    })

    await h.loop.start()
    expect(h.ticks.length).toBe(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(h.ticks.length).toBe(2) // the loop rescheduled despite the rejection
    h.loop.stop()
  })

  // Regression: only `start()`'s tick was caught. The scheduled path used
  // Regression: the in-flight guard on the visibility catch-up was one global
  // counter, so a poll abandoned by an earlier generation — a restart leaves the
  // old tick running on purpose — also suppressed the catch-up for the live
  // chain. Nothing re-arms behind an abandoned tick (its own `.finally` sees
  // g !== gen), so the loop simply waited out the full interval, and forever if
  // that request never settled.
  it("catches up while an abandoned generation's poll is still in flight", async () => {
    let releaseStale!: () => void
    const stale = new Promise<void>((resolve) => {
      releaseStale = resolve
    })
    let first = true
    const h = mountLoop(() => {
      if (!first) return
      first = false
      return stale // generation 1 never settles until we let it
    }, 1000)

    void h.loop.start() // generation 1: hangs
    await flush()
    expect(h.ticks.length).toBe(1)

    await h.loop.start() // restart: generation 2 polls and completes
    expect(h.ticks.length).toBe(2)

    setHidden(true)
    await vi.advanceTimersByTimeAsync(1500) // away for more than one interval
    fireVisibilityChange(false)
    await flush()

    // Generation 1 is still unresolved; the catch-up must run regardless.
    expect(h.ticks.length).toBe(3)
    releaseStale()
    h.loop.stop()
  })

  // `.finally()`, which re-throws the reason it observed, and the visibility
  // catch-up had no handler at all — so every failing poll after the first
  // raised an unhandled rejection (a console error in the browser, and a failed
  // run under vitest) even though the loop itself stayed armed.
  it("never leaks an unhandled rejection from a failing poll", async () => {
    const leaked: unknown[] = []
    const onLeak = (reason: unknown): void => {
      leaked.push(reason)
    }
    // Reached off globalThis with a local type: the app's tsconfig has no Node
    // types (it builds for the browser), and jsdom does not forward a Node
    // promise rejection to window's `unhandledrejection` event.
    const node = globalThis as unknown as {
      process: {
        on: (event: "unhandledRejection", listener: (reason: unknown) => void) => void
        off: (event: "unhandledRejection", listener: (reason: unknown) => void) => void
      }
    }
    node.process.on("unhandledRejection", onLeak)
    try {
      const h = mountLoop(() => Promise.reject(new Error("boom")))
      await h.loop.start() // start path
      await vi.advanceTimersByTimeAsync(1000) // scheduled path
      setHidden(true)
      await vi.advanceTimersByTimeAsync(1500) // away long enough to earn a catch-up
      fireVisibilityChange(false) // visibility catch-up path
      await flush()
      expect(h.ticks.length).toBe(3) // all three paths really ran
      h.loop.stop()
      // Node reports an unhandled rejection only once the microtask queue has
      // drained, so give it a real macrotask to do so.
      vi.useRealTimers()
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      node.process.off("unhandledRejection", onLeak)
    }

    expect(leaked).toEqual([])
  })
})
