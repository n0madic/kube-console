// Visibility-gated, generation-guarded polling loop shared by the metrics and
// cluster-summary composables. It owns the self-rescheduling timer, the
// document `visibilitychange` listener and unmount teardown; the caller
// supplies the poll (`tick`) and the interval. `tick` receives the live
// generation and must guard its post-await writes with `isCurrent(gen)` so a
// response that resolves after a stop/restart is discarded.
//
// `intervalMs` is the loop's one cadence guarantee: no path here starts a poll
// less than that after the last one — including the catch-up when the tab comes
// back, which is throttled against it rather than firing per visibility flip.

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
  /** When the last poll *started* — the throttle for the visibility catch-up. */
  let lastTickMs = 0
  /**
   * Polls currently in flight, counted per generation.
   *
   * A counter, because a restart can briefly overlap the old generation's last
   * tick with the new one's first — and keyed by generation for the same reason:
   * the only question the catch-up below asks is whether *this* cycle's poll is
   * already running. A single global counter answered for the abandoned one too,
   * so a slow tick left behind by a stop()/start() (its own `.finally` re-arms
   * nothing — `g !== gen`) suppressed the catch-up for the live chain until it
   * settled, and forever if it never did.
   */
  const inFlight = new Map<number, number>()

  function pending(g: number): number {
    return inFlight.get(g) ?? 0
  }

  function isCurrent(g: number): boolean {
    return g === gen && live
  }

  function clearTimer(): void {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
  }

  /**
   * Run one poll, swallowing its rejection.
   *
   * Every path that runs a tick goes through here, because none of them has
   * anywhere to report a failure: the timer and the visibility listener have no
   * caller at all, and `start()`'s promise is discarded by every consumer
   * (`void loop.start()`). `.finally()` is NOT this — it re-throws the reason it
   * observed, so the self-rescheduling path was still raising an unhandled
   * rejection on every failing poll even though it did stay armed. A tick that
   * wants its failure seen surfaces it itself (they all set an `error` ref).
   */
  function runTick(g: number): Promise<void> {
    // Stamped on entry, not on completion: the throttle below must bound how
    // often a poll is *started*, or a slow tick would still let a burst queue up.
    lastTickMs = Date.now()
    inFlight.set(g, pending(g) + 1)
    return Promise.resolve(tick(g))
      .catch(() => undefined)
      .finally(() => {
        const left = pending(g) - 1
        // Deleted at zero so the map cannot grow by one entry per restart.
        if (left <= 0) inFlight.delete(g)
        else inFlight.set(g, left)
      })
  }

  function schedule(g: number): void {
    if (g !== gen || !live) return
    timer = window.setTimeout(() => {
      timer = null // fired — clearTimer must only ever cancel a *pending* poll
      if (g !== gen || !live) return
      if (document.hidden) {
        schedule(g) // stay armed; skip the poll while the tab is hidden
        return
      }
      void runTick(g).finally(() => schedule(g))
    }, intervalMs())
  }

  function onVisibilityChange(): void {
    if (document.hidden || !live) return
    // Catch up when the tab comes back — but never faster than the interval the
    // caller asked for. The timer stays armed while hidden (it only skips the
    // poll), so a tab away for less than one interval already has a poll coming,
    // and an unthrottled catch-up turned every alt-tab into an extra full poll:
    // ProblemPodsCard walks every pod in the cluster and its 60s cadence is
    // deliberate, and the metrics charts of the page behind it fire alongside it.
    if (Date.now() - lastTickMs < intervalMs()) return
    // A poll of *this generation* still in flight is this cycle's poll — its
    // `.finally` re-arms the timer. The throttle alone cannot see it (lastTickMs
    // marks the start, so a tick outlasting the interval passes), and running
    // the catch-up beside it would leave two `.finally` handlers each scheduling
    // the same live generation: a permanently doubled chain. An abandoned older
    // generation's poll is deliberately not counted — nothing re-arms behind it.
    if (pending(gen) > 0) return
    // Re-arm from now, replacing the pending timer: the catch-up *is* this
    // cycle's poll, and leaving the old timer would fire another one right
    // behind it. The generation is captured, like every other tick path, so a
    // stop/restart during the poll cannot arm a second chain.
    const g = gen
    clearTimer()
    void runTick(g).finally(() => schedule(g))
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
    // A rejecting first poll must not kill the loop: without runTick's catch it
    // would skip schedule() and leave nothing armed, silently.
    await runTick(g)
    if (g !== gen) return
    schedule(g)
  }

  function stop(): void {
    gen += 1
    live = false
    clearTimer()
    document.removeEventListener("visibilitychange", onVisibilityChange)
    onStop()
  }

  onBeforeUnmount(stop)

  return { isCurrent, start, stop }
}
