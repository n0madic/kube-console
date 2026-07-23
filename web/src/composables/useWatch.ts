// Kubernetes watch over the raw gateway: incremental NDJSON reading,
// bookmarks, 410-driven relist and bounded exponential backoff. The watch is
// always closed on component unmount / route change.

import { onBeforeUnmount } from "vue"

import { apiFetch } from "@/api/http"
import type { WatchEvent } from "@/api/types"

export interface UseWatchOptions {
  /** Build the watch URL for the current resourceVersion; null disables. */
  buildUrl: () => string | null
  onEvent: (event: WatchEvent) => void
  /** Called on 410 Gone (HTTP or ERROR event): the caller must relist. */
  onStale: () => void
  /** Extra request headers (e.g. Table Accept). */
  headers?: Record<string, string>
}

const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000

export function useWatch(options: UseWatchOptions) {
  let controller: AbortController | null = null
  let stopped = true
  let backoffMs = INITIAL_BACKOFF_MS
  let generation = 0

  async function runOnce(signal: AbortSignal): Promise<"stale" | "retry" | "aborted"> {
    const url = options.buildUrl()
    if (url === null) return "aborted"
    let resp: Response
    try {
      resp = await apiFetch(url, { signal, headers: options.headers })
    } catch (e) {
      if (signal.aborted) return "aborted"
      const status =
        typeof e === "object" && e !== null ? (e as { status?: number }).status : undefined
      if (status === 410) return "stale"
      // 401: apiFetch already ran the logout handler; stop retrying against a
      // dead session instead of looping until the component unmounts.
      if (status === 401) return "aborted"
      return "retry"
    }
    const body = resp.body
    if (body === null) return "retry"

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // A chunk can resolve concurrently with stop()/relist (which aborts the
        // signal and bumps the generation). Deliver nothing from an aborted
        // stream — otherwise a stale event upserts a foreign row and rewinds
        // resourceVersion to the superseded stream's value.
        if (signal.aborted) break
        buffer += decoder.decode(value, { stream: true })
        let idx = buffer.indexOf("\n")
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          idx = buffer.indexOf("\n")
          if (line === "") continue
          let event: WatchEvent
          try {
            event = JSON.parse(line) as WatchEvent
          } catch {
            continue
          }
          if (event.type === "ERROR") {
            const code = (event.object as { code?: number }).code
            if (code === 410) return "stale"
            // An ERROR frame is not a healthy stream: fall through to a backoff
            // retry without resetting it, so a stream that only ever emits an
            // error does not busy-loop reconnecting.
            return "retry"
          }
          // A healthy data event resets the backoff.
          backoffMs = INITIAL_BACKOFF_MS
          options.onEvent(event)
        }
      }
    } catch {
      if (signal.aborted) return "aborted"
      return "retry"
    } finally {
      reader.releaseLock()
    }
    return signal.aborted ? "aborted" : "retry"
  }

  async function loop(myGeneration: number): Promise<void> {
    while (!stopped && myGeneration === generation) {
      const attempt = new AbortController()
      controller = attempt
      const outcome = await runOnce(attempt.signal)
      // Close this attempt for good before the next iteration replaces
      // `controller`. A "retry" returned from inside the read loop (an ERROR
      // frame, a decode/read failure) leaves the response body open, and the
      // dropped controller can never abort it again — every backoff cycle would
      // leak another live fetch, and with it the apiserver watch behind it.
      attempt.abort()
      if (stopped || myGeneration !== generation) return
      if (outcome === "aborted") return
      if (outcome === "stale") {
        stopped = true
        options.onStale()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
    }
  }

  /** (Re)start watching; safe to call after onStale + relist. */
  function start(): void {
    stop()
    stopped = false
    backoffMs = INITIAL_BACKOFF_MS
    generation += 1
    void loop(generation)
  }

  function stop(): void {
    stopped = true
    generation += 1
    controller?.abort()
    controller = null
  }

  onBeforeUnmount(stop)

  return { start, stop }
}
