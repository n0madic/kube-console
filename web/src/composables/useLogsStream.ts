// Streaming pod logs over the raw gateway with AbortController lifecycle.

import { onBeforeUnmount, ref, shallowRef } from "vue"

import { ApiError, apiFetch, messageFromError } from "@/api/http"

// The viewer holds the whole log in memory, so "Tail: All" needs a ceiling.
// 200k lines is ~20-40 MB of strings — well under what the kubelet keeps per
// container by default (containerLogMaxSize 10Mi x containerLogMaxFiles 5),
// so in practice the cap is only reached by exceptionally chatty containers.
export const MAX_LINES = 200000

// Lines are merged into the reactive buffer at most once per window instead of
// once per network chunk: a bulk load arrives as hundreds of chunks, and each
// merge re-renders the viewer.
const FLUSH_INTERVAL_MS = 50

// Reconnect backoff for a followed stream that dropped. The first attempt is
// immediate: the usual cause is an idle connection reaped by something between
// the browser and the kubelet (an ingress read timeout, a load balancer, the
// kubelet's own --streaming-connection-idle-timeout), and that reconnects at
// once. Only a backend that is really unreachable ever reaches the cap.
const RETRY_FIRST_MS = 1000
const RETRY_MAX_MS = 15000
// A connection that lived at least this long counts as healthy, so the next
// drop starts the backoff over instead of inheriting the previous one — an
// idle timeout fires again after the same quiet interval, not sooner.
const RETRY_RESET_MS = 10000

export interface StartOptions {
  /**
   * Builds the URL to reconnect with, and is supplied **only for a followed
   * stream**: `follow=true` is a request that is not supposed to end, so when
   * one fails it is reconnected instead of reported. Without it a failure is
   * final, which is what every non-followed read wants.
   *
   * The argument is how many seconds of log to re-request — the log endpoint
   * has no offset and no continue token, so the only way back to where the
   * stream stopped is a time window — or null when nothing has arrived yet and
   * the original request should simply be repeated. Returning null declines the
   * reconnect and lets the error surface.
   */
  resume?: (sinceSeconds: number | null) => string | null
}

// One connection either ends, is disowned (stop/restart), or fails. Whether a
// failure is final or the prelude to a reconnect is start()'s decision, so a
// single attempt never writes `error` for one.
type Attempt = "ended" | "aborted" | { failure: unknown }

// A status the apiserver chose — the pod is gone, the container never ran, the
// token may not read logs — will not start working by being asked again. A
// dropped connection or a 5xx from a restarting apiserver is worth retrying.
function isFatal(e: unknown): boolean {
  return e instanceof ApiError && e.status >= 400 && e.status < 500
}

export function useLogsStream() {
  const lines = shallowRef<string[]>([])
  // The reactive signal for `lines`, bumped on every mutation of it.
  //
  // `lines` is a shallowRef appended to **in place**, and neither half of that
  // signals anything on its own: mutating the array is invisible to a
  // shallowRef, and re-assigning the same array is a no-op (Object.is). The
  // alternative — handing over a fresh array per flush — was the whole cost of
  // this composable: the window bounds how *often* a flush happens, not what it
  // costs, so with "Tail: All" and MAX_LINES a bulk load copied a ~100k-line
  // buffer once per chunk, i.e. quadratically in the lines loaded.
  //
  // Consumers therefore depend on this counter, not on the array's identity or
  // its length (which stops changing once the buffer sits at the cap).
  const linesVersion = ref(0)
  const running = ref(false)
  const error = ref<string | null>(null)
  // The message of the failure currently being retried, null while the stream
  // is connected. One ref rather than a boolean beside `error`: the viewer has
  // to say both that the stream dropped and why, and `error` is reserved for a
  // failure nobody is going to fix by waiting.
  const reconnecting = ref<string | null>(null)
  // Set once the head of the log had to be dropped. With "All" the user is
  // explicitly asking for the beginning, so trimming it silently would lie.
  const truncated = ref(false)

  let controller: AbortController | null = null
  // Monotonic id of the current stream. Every start()/stop() bumps it, so a
  // slow read from a superseded stream (e.g. after a Pod/container switch) can
  // detect that it is stale and drop its chunk instead of appending it — or
  // clobbering — the new stream's lines. Aborting the fetch is not enough: a
  // read may already have resolved with data before the abort is observed.
  let generation = 0

  let pending: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  // Wall-clock time the last line was staged, and the only cursor a resume can
  // be built from. Taken on arrival rather than parsed out of the line, so it
  // needs neither timestamps=true nor a clock shared with the node: what goes
  // upstream is a duration, and the node subtracts it from its own now. It errs
  // toward re-delivering the last fraction of a second (transport latency sits
  // inside the window) rather than leaving a hole.
  let lastLineAt: number | null = null
  // Resolves the pending backoff wait early, so stop() never leaves start()
  // suspended on a timer nobody is waiting for any more.
  let cancelRetry: (() => void) | null = null

  // Drops the head in place. `splice` shifts the survivors down inside the
  // existing array; returning a `slice` would allocate a second full copy of
  // the buffer on top of the append, on every flush past the cap.
  //
  // Applying it to the staging array as well as the visible one cannot leave a
  // gap in the middle of the log, which is worth spelling out because it looks
  // like it could: trimming staging leaves it holding exactly MAX_LINES, so the
  // flush that follows appends onto a buffer of length B and then drops exactly
  // B from the head — i.e. the whole previous buffer. What survives is always
  // the contiguous tail `truncated` advertises.
  function trim(buffer: string[]): void {
    if (buffer.length <= MAX_LINES) return
    truncated.value = true
    buffer.splice(0, buffer.length - MAX_LINES)
  }

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.length === 0) return
    const buffer = lines.value
    // One element at a time rather than push(...pending): a spread passes every
    // staged line as an argument, and pending holds up to MAX_LINES of them —
    // far past the engine's argument limit.
    for (const line of pending) buffer.push(line)
    pending = []
    trim(buffer)
    linesVersion.value++
  }

  function append(newLines: string[]): void {
    if (newLines.length === 0) return
    lastLineAt = Date.now()
    for (const line of newLines) pending.push(line)
    // A hidden tab still streams while timers are throttled, so the staging
    // buffer gets the same ceiling as the visible one.
    trim(pending)
    if (timer !== null) return
    const gen = generation
    timer = setTimeout(() => {
      timer = null
      if (gen === generation) flush()
    }, FLUSH_INTERVAL_MS)
  }

  // A restart must really empty the buffer, and must say so: appends are in
  // place, so a consumer that depends on the version counter alone would keep
  // the previous pod's lines on screen until the next flush bumped it.
  function reset(): void {
    lines.value = []
    linesVersion.value++
  }

  /** One connection, read to its end. Never touches `error` for a failure. */
  async function runOnce(url: string, gen: number): Promise<Attempt> {
    const ctrl = new AbortController()
    controller = ctrl
    const signal = ctrl.signal
    try {
      const resp = await apiFetch(url, { signal })
      if (gen !== generation) return "aborted"
      // Connected: whatever we were retrying is over.
      reconnecting.value = null
      const body = resp.body
      if (body === null) {
        error.value = "Empty log stream."
        return "ended"
      }
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (gen !== generation) return "aborted"
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split("\n")
        buffer = parts.pop() ?? ""
        append(parts)
      }
      if (buffer !== "") append([buffer])
      return "ended"
    } catch (e) {
      if (signal.aborted || gen !== generation) return "aborted"
      return { failure: e }
    }
  }

  /** Seconds of log a reconnect must re-request, null if nothing arrived yet. */
  function sinceLastLine(): number | null {
    if (lastLineAt === null) return null
    // Rounded up and padded by a second: the endpoint's window is whole
    // seconds, and a duplicated line at the seam is recoverable where a
    // missing one is not.
    return Math.ceil((Date.now() - lastLineAt) / 1000) + 1
  }

  function wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms)
      cancelRetry = done
      function done(): void {
        clearTimeout(t)
        cancelRetry = null
        resolve()
      }
    })
  }

  async function start(url: string, opts: StartOptions = {}): Promise<void> {
    stop()
    const gen = generation
    reset()
    error.value = null
    reconnecting.value = null
    truncated.value = false
    lastLineAt = null
    running.value = true
    let target = url
    let delay = 0
    try {
      for (;;) {
        const attemptStart = Date.now()
        const attempt = await runOnce(target, gen)
        if (gen !== generation || attempt === "aborted") return
        // A clean end is deliberately final, reconnect or not: it is how the
        // endpoint reports that there is no more log to follow (the container
        // terminated, `previous=true` reached the end of a finished one), so
        // reconnecting would re-read the same log forever.
        if (attempt === "ended") return

        const message = messageFromError(attempt.failure, "Log stream failed.")
        const resumed = isFatal(attempt.failure) ? null : (opts.resume?.(sinceLastLine()) ?? null)
        if (resumed === null) {
          error.value = message
          return
        }
        target = resumed
        if (Date.now() - attemptStart >= RETRY_RESET_MS) delay = 0
        reconnecting.value = message
        // Whatever the dead connection staged belongs on screen now rather than
        // after the reconnect: the window only coalesces bursts.
        flush()
        await wait(delay)
        if (gen !== generation) return
        delay = delay === 0 ? RETRY_FIRST_MS : Math.min(delay * 2, RETRY_MAX_MS)
      }
    } finally {
      if (gen === generation) {
        // The window only coalesces bursts; whatever a finished stream staged
        // must be on screen the moment it stops running.
        flush()
        running.value = false
        reconnecting.value = null
      }
    }
  }

  function stop(): void {
    // Bumping the generation also disowns anything staged: a scheduled flush
    // checks it, so a superseded stream can never append to the new buffer.
    generation++
    pending = []
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    // Ends a backoff wait as well as a live read: the loop re-checks the
    // generation the moment it resumes and drops out there.
    cancelRetry?.()
    controller?.abort()
    controller = null
    running.value = false
    reconnecting.value = null
  }

  onBeforeUnmount(stop)

  return { lines, linesVersion, running, error, reconnecting, truncated, start, stop }
}
