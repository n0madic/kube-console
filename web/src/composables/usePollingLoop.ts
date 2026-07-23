// Visibility-gated, generation-guarded polling loop shared by the metrics and
// cluster-summary composables. It owns the self-rescheduling timer, the
// document `visibilitychange` listener and unmount teardown; the caller
// supplies the poll (`tick`) and the interval. `tick` receives the live
// generation and must guard its post-await writes with `isCurrent(gen)` so a
// response that resolves after a stop/restart is discarded.

import { onBeforeUnmount } from "vue"

export interface PollingLoop {
  /** True while `gen` is the live chain — guard every post-await write with it. */
  isCurrent: (gen: number) => boolean
  /**
   * (Re)start the loop. Bumps the generation, then — if `gate` resolves true
   * (or is omitted) — installs the visibility listener, polls immediately and
   * self-reschedules. The returned promise settles after the first poll.
   */
  start: (gate?: (gen: number) => Promise<boolean> | boolean) => Promise<void>
  /** Stop polling: bump the generation, clear the timer, drop the listener. */
  stop: () => void
}

const noop = (): void => {}

export function usePollingLoop(
  tick: (gen: number) => Promise<void> | void,
  intervalMs: () => number,
  /** Runs synchronously inside every stop() (including restart and unmount) —
   *  use it to invalidate in-flight work the loop's generation can't see. */
  onStop: () => void = noop,
): PollingLoop {
  let timer: number | null = null
  let gen = 0
  let live = false

  function isCurrent(g: number): boolean {
    return g === gen && live
  }

  function schedule(g: number): void {
    if (g !== gen || !live) return
    timer = window.setTimeout(() => {
      if (g !== gen || !live) return
      if (document.hidden) {
        schedule(g) // stay armed; skip the poll while the tab is hidden
        return
      }
      void Promise.resolve(tick(g)).finally(() => schedule(g))
    }, intervalMs())
  }

  function onVisibilityChange(): void {
    // Catch up immediately when the tab becomes visible again.
    if (!document.hidden && live) void Promise.resolve(tick(gen))
  }

  async function start(gate?: (gen: number) => Promise<boolean> | boolean): Promise<void> {
    stop()
    const g = ++gen
    if (gate !== undefined) {
      const proceed = await gate(g)
      if (g !== gen) return // superseded during the gate
      if (!proceed) return
    }
    live = true
    document.addEventListener("visibilitychange", onVisibilityChange)
    await Promise.resolve(tick(g))
    if (g !== gen) return
    schedule(g)
  }

  function stop(): void {
    gen += 1
    live = false
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
    document.removeEventListener("visibilitychange", onVisibilityChange)
    onStop()
  }

  onBeforeUnmount(stop)

  return { isCurrent, start, stop }
}
