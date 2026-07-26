// Streaming pod logs over the raw gateway with AbortController lifecycle.

import { onBeforeUnmount, ref, shallowRef } from "vue"

import { apiFetch, messageFromError } from "@/api/http"

// The viewer holds the whole log in memory, so "Tail: All" needs a ceiling.
// 200k lines is ~20-40 MB of strings — well under what the kubelet keeps per
// container by default (containerLogMaxSize 10Mi x containerLogMaxFiles 5),
// so in practice the cap is only reached by exceptionally chatty containers.
export const MAX_LINES = 200000

// Lines are merged into the reactive buffer at most once per window instead of
// once per network chunk: a bulk load arrives as hundreds of chunks, and each
// merge re-renders the viewer.
const FLUSH_INTERVAL_MS = 50

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

  async function start(url: string): Promise<void> {
    stop()
    const gen = generation
    reset()
    error.value = null
    truncated.value = false
    controller = new AbortController()
    const signal = controller.signal
    running.value = true
    try {
      const resp = await apiFetch(url, { signal })
      if (gen !== generation) return
      const body = resp.body
      if (body === null) {
        error.value = "Empty log stream."
        return
      }
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (gen !== generation) return
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split("\n")
        buffer = parts.pop() ?? ""
        append(parts)
      }
      if (buffer !== "") append([buffer])
    } catch (e) {
      if (!signal.aborted && gen === generation) {
        error.value = messageFromError(e, "Log stream failed.")
      }
    } finally {
      if (gen === generation) {
        // The window only coalesces bursts; whatever a finished stream staged
        // must be on screen the moment it stops running.
        flush()
        running.value = false
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
    controller?.abort()
    controller = null
    running.value = false
  }

  onBeforeUnmount(stop)

  return { lines, linesVersion, running, error, truncated, start, stop }
}
