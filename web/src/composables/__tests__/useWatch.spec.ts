import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"

vi.mock("@/api/http", async () => {
  const actual = await vi.importActual<typeof import("@/api/http")>("@/api/http")
  return { ...actual, apiFetch: vi.fn() }
})

import { apiFetch, ApiError } from "@/api/http"
import { useWatch, type UseWatchOptions } from "@/composables/useWatch"

const mockedFetch = vi.mocked(apiFetch)

// A minimal Response whose reader yields one NDJSON line then EOF, using only
// resolved promises (microtasks) so fake timers flush it deterministically —
// a real ReadableStream can resolve reads on macrotasks and stall the clock.
function ndjsonResponse(line: string): Response {
  const enc = new TextEncoder()
  let sent = false
  return {
    body: {
      getReader() {
        return {
          read() {
            if (!sent) {
              sent = true
              return Promise.resolve({ done: false, value: enc.encode(line + "\n") })
            }
            return Promise.resolve({ done: true, value: undefined })
          },
          releaseLock() {},
        }
      },
    },
  } as unknown as Response
}

function mountWatch(opts: UseWatchOptions): { watcher: ReturnType<typeof useWatch> } {
  let watcher!: ReturnType<typeof useWatch>
  const Host = defineComponent({
    setup() {
      watcher = useWatch(opts)
      return () => h("div")
    },
  })
  mount(Host)
  return { watcher }
}

describe("useWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockedFetch.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("does not reset the backoff on a non-410 ERROR frame", async () => {
    mockedFetch.mockImplementation(() =>
      Promise.resolve(ndjsonResponse(`{"type":"ERROR","object":{"code":500}}`)),
    )
    const { watcher } = mountWatch({
      buildUrl: () => "/k8s/api/v1/pods?watch=true",
      onEvent: () => {},
      onStale: () => {},
    })
    watcher.start()

    // First reconnect runs immediately, then backs off 1000ms (same in both the
    // correct and the buggy behavior).
    await vi.advanceTimersByTimeAsync(0)
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockedFetch).toHaveBeenCalledTimes(2)

    // The second backoff must have GROWN to 2000ms. After only 1000ms more there
    // must be no third call — the bug (reset on ERROR) would keep it at 1000ms.
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockedFetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockedFetch).toHaveBeenCalledTimes(3)

    watcher.stop()
  })

  // Regression: the per-attempt AbortController was replaced on every reconnect
  // without ever being aborted. A "retry" returned from inside the read loop
  // (an ERROR frame, a read failure) leaves the response body open, so each
  // backoff cycle leaked one live fetch — and the apiserver watch behind it.
  it("aborts a retried attempt so its response body cannot leak", async () => {
    const signals: AbortSignal[] = []
    mockedFetch.mockImplementation((_url, init) => {
      if (init?.signal != null) signals.push(init.signal)
      return Promise.resolve(ndjsonResponse(`{"type":"ERROR","object":{"code":500}}`))
    })
    const { watcher } = mountWatch({
      buildUrl: () => "/k8s/api/v1/pods?watch=true",
      onEvent: () => {},
      onStale: () => {},
    })
    watcher.start()

    await vi.advanceTimersByTimeAsync(0)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)

    await vi.advanceTimersByTimeAsync(1000)
    expect(signals).toHaveLength(2)
    expect(signals[1]?.aborted).toBe(true)

    watcher.stop()
  })

  it("stops retrying after a 401 instead of looping against a dead session", async () => {
    mockedFetch.mockRejectedValue(new ApiError(401, "unauthorized"))
    const { watcher } = mountWatch({
      buildUrl: () => "/k8s/api/v1/pods?watch=true",
      onEvent: () => {},
      onStale: () => {},
    })
    watcher.start()

    await vi.advanceTimersByTimeAsync(0)
    expect(mockedFetch).toHaveBeenCalledTimes(1)

    // No reconnect: advancing well past any backoff yields no further calls.
    await vi.advanceTimersByTimeAsync(60000)
    expect(mockedFetch).toHaveBeenCalledTimes(1)

    watcher.stop()
  })
})
