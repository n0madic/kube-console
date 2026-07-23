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
// merge copies the whole buffer and re-renders the viewer.
const FLUSH_INTERVAL_MS = 50

export function useLogsStream() {
  const lines = shallowRef<string[]>([])
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

  function trim(buffer: string[]): string[] {
    if (buffer.length <= MAX_LINES) return buffer
    truncated.value = true
    return buffer.slice(buffer.length - MAX_LINES)
  }

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.length === 0) return
    const merged = lines.value.concat(pending)
    pending = []
    lines.value = trim(merged)
  }

  function append(newLines: string[]): void {
    if (newLines.length === 0) return
    for (const line of newLines) pending.push(line)
    // A hidden tab still streams while timers are throttled, so the staging
    // buffer gets the same ceiling as the visible one.
    pending = trim(pending)
    if (timer !== null) return
    const gen = generation
    timer = setTimeout(() => {
      timer = null
      if (gen === generation) flush()
    }, FLUSH_INTERVAL_MS)
  }

  async function start(url: string): Promise<void> {
    stop()
    const gen = generation
    lines.value = []
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

  return { lines, running, error, truncated, start, stop }
}
