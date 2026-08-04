import { mount } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h, nextTick, watch } from "vue"

vi.mock("@/api/http", async () => {
  const actual = await vi.importActual<typeof import("@/api/http")>("@/api/http")
  return { ...actual, apiFetch: vi.fn() }
})

import { ApiError, apiFetch } from "@/api/http"
import { MAX_LINES, useLogsStream } from "@/composables/useLogsStream"

const mockedFetch = vi.mocked(apiFetch)

const encoder = new TextEncoder()

function useInHost(): ReturnType<typeof useLogsStream> {
  let stream!: ReturnType<typeof useLogsStream>
  const Host = defineComponent({
    setup() {
      stream = useLogsStream()
      return () => h("div")
    },
  })
  mount(Host)
  return stream
}

/** Response whose body streams the given chunks, honoring the abort signal. */
function streamResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body)
}

/** Response whose body the test feeds one chunk at a time. */
function manualResponse(): {
  resp: Response
  push: (text: string) => void
  close: () => void
  fail: (e: unknown) => void
} {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
    },
  })
  return {
    resp: new Response(body),
    push: (text) => ctrl.enqueue(encoder.encode(text)),
    close: () => ctrl.close(),
    // How a connection reaped mid-stream reaches the reader: the body errors,
    // never a clean done.
    fail: (e) => ctrl.error(e),
  }
}

/**
 * Waits for the flush of a just-fed chunk: the 50ms window plus however long
 * reading and staging it takes (a 200k-line chunk is not instant). Exactly one
 * flush per call — with nothing staged the window is not armed again. Real
 * timers throughout: the reads go through the platform's ReadableStream, whose
 * queue is not a fake clock's.
 */
async function nextFlush(version: { value: number }): Promise<void> {
  const before = version.value
  for (let i = 0; i < 200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (version.value !== before) return
  }
  throw new Error("no flush within 4s")
}

function joinedLines(prefix: string, from: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${from + i}`).join("\n") + "\n"
}

describe("useLogsStream", () => {
  afterEach(() => {
    mockedFetch.mockReset()
  })

  it("assembles lines split across chunk boundaries and flushes the tail", async () => {
    mockedFetch.mockResolvedValue(streamResponse(["first li", "ne\nsecond\nthi", "rd"]))
    const stream = useInHost()

    await stream.start("/k8s/api/v1/namespaces/ns/pods/p/log")

    expect(stream.lines.value).toEqual(["first line", "second", "third"])
    expect(stream.running.value).toBe(false)
    expect(stream.error.value).toBeNull()
  })

  it("caps the buffer keeping the newest and reports the drop", async () => {
    const total = MAX_LINES + 5
    const text = Array.from({ length: total }, (_, i) => `line-${i}`).join("\n") + "\n"
    mockedFetch.mockResolvedValue(streamResponse([text]))
    const stream = useInHost()

    await stream.start("/url")

    expect(stream.lines.value).toHaveLength(MAX_LINES)
    expect(stream.lines.value[0]).toBe(`line-${total - MAX_LINES}`)
    expect(stream.lines.value.at(-1)).toBe(`line-${total - 1}`)
    // "Tail: All" asks for the beginning, so a silent trim would mislead.
    expect(stream.truncated.value).toBe(true)
  })

  it("clears the truncation flag on restart", async () => {
    const text = Array.from({ length: MAX_LINES + 5 }, (_, i) => `line-${i}`).join("\n") + "\n"
    mockedFetch.mockResolvedValueOnce(streamResponse([text]))
    const stream = useInHost()
    await stream.start("/url")
    expect(stream.truncated.value).toBe(true)

    mockedFetch.mockResolvedValueOnce(streamResponse(["short\n"]))
    await stream.start("/url")

    expect(stream.truncated.value).toBe(false)
    expect(stream.lines.value).toEqual(["short"])
  })

  it("batches chunks into one buffer update but shows everything when done", async () => {
    const chunks = Array.from({ length: 50 }, (_, i) => `line-${i}\n`)
    mockedFetch.mockResolvedValue(streamResponse(chunks))
    const stream = useInHost()

    let updates = 0
    // The counter is the signal, not the array: lines are appended in place, so
    // watching `lines` itself would only ever see the reset in start().
    watch(stream.linesVersion, () => updates++)

    await stream.start("/url")
    await nextTick()

    expect(stream.lines.value).toHaveLength(50)
    // One reset on start plus the final flush — never one per chunk.
    expect(updates).toBeLessThanOrEqual(2)
  })

  // The buffer is appended to in place and the change announced by bumping
  // `linesVersion`. Handing over a fresh array per flush (lines.concat(pending))
  // was the quadratic cost this replaces: the flush window bounds how often a
  // merge happens, not what it costs, so a bulk load into a capped 200k-line
  // buffer copied ~100k lines per chunk.
  it("appends into the same array across flushes and signals with a version bump", async () => {
    const feed = manualResponse()
    mockedFetch.mockResolvedValue(feed.resp)
    const stream = useInHost()
    const done = stream.start("/url")
    // start() resets synchronously, so this is the buffer of the new stream.
    const buffer = stream.lines.value
    const afterReset = stream.linesVersion.value

    feed.push("a\n")
    await nextFlush(stream.linesVersion)
    expect(stream.lines.value).toEqual(["a"])
    expect(stream.linesVersion.value).toBeGreaterThan(afterReset)
    const afterFirst = stream.linesVersion.value

    feed.push("b\nc\n")
    await nextFlush(stream.linesVersion)
    expect(stream.lines.value).toEqual(["a", "b", "c"])
    expect(stream.linesVersion.value).toBeGreaterThan(afterFirst)
    // The point of the counter: nothing about the array itself changed.
    expect(stream.lines.value).toBe(buffer)

    feed.close()
    await done
    expect(stream.lines.value).toBe(buffer)
    expect(stream.running.value).toBe(false)
  })

  // The cost check. Wall-clock timing would be flaky, so the whole-buffer copies
  // themselves are counted: `concat` in flush() and `slice` in trim() were the
  // two, and only arrays holding this test's own log lines are counted so no
  // unrelated call can decide the outcome.
  it("never copies the whole buffer while appending", async () => {
    const COPY_THRESHOLD = 500
    type ArrayCopy = (this: unknown[], ...args: unknown[]) => unknown[]
    const proto = Array.prototype as unknown as Record<"concat" | "slice", ArrayCopy>
    const realConcat = proto.concat
    const realSlice = proto.slice
    const copies: number[] = []
    function watchCopies(real: ArrayCopy): ArrayCopy {
      return function (this: unknown[], ...args: unknown[]) {
        const first = this[0]
        const isLogBuffer = typeof first === "string" && first.startsWith("line-")
        if (isLogBuffer && this.length >= COPY_THRESHOLD) copies.push(this.length)
        return real.apply(this, args)
      }
    }

    const feed = manualResponse()
    mockedFetch.mockResolvedValue(feed.resp)
    const stream = useInHost()
    const done = stream.start("/url")
    proto.concat = watchCopies(realConcat)
    proto.slice = watchCopies(realSlice)
    try {
      for (let i = 0; i < 10; i++) {
        feed.push(joinedLines("line-", i * 200, 200))
        await nextFlush(stream.linesVersion)
      }
      feed.close()
      await done
    } finally {
      proto.concat = realConcat
      proto.slice = realSlice
    }

    expect(stream.lines.value).toHaveLength(2000)
    expect(stream.lines.value[0]).toBe("line-0")
    expect(stream.lines.value.at(-1)).toBe("line-1999")
    expect(copies).toEqual([])
  })

  it("drops the head in place once the buffer reaches the cap", async () => {
    const feed = manualResponse()
    mockedFetch.mockResolvedValue(feed.resp)
    const stream = useInHost()
    const done = stream.start("/url")
    const buffer = stream.lines.value

    feed.push(joinedLines("line-", 0, MAX_LINES))
    await nextFlush(stream.linesVersion)
    expect(stream.lines.value).toHaveLength(MAX_LINES)
    expect(stream.truncated.value).toBe(false)

    feed.push(joinedLines("line-", MAX_LINES, 2))
    await nextFlush(stream.linesVersion)

    expect(stream.lines.value).toBe(buffer)
    expect(stream.lines.value).toHaveLength(MAX_LINES)
    expect(stream.lines.value[0]).toBe("line-2")
    expect(stream.lines.value.at(-1)).toBe(`line-${MAX_LINES + 1}`)
    expect(stream.truncated.value).toBe(true)

    feed.close()
    await done
  })

  it("shows no line from the previous stream after a restart", async () => {
    mockedFetch.mockResolvedValueOnce(streamResponse(["old-1\nold-2\n"]))
    const stream = useInHost()
    await stream.start("/podA/log")
    expect(stream.lines.value).toEqual(["old-1", "old-2"])
    const beforeRestart = stream.linesVersion.value

    // A pod that has not logged anything yet, so nothing but the reset itself
    // can announce the change.
    const feed = manualResponse()
    mockedFetch.mockResolvedValueOnce(feed.resp)
    const done = stream.start("/podB/log")

    expect(stream.lines.value).toEqual([])
    // Checked before the first flush on purpose: appends are in place, so a
    // consumer watching only the counter would keep the previous pod's lines on
    // screen until a flush it may wait arbitrarily long for.
    expect(stream.linesVersion.value).toBeGreaterThan(beforeRestart)

    feed.push("new-1\n")
    await nextFlush(stream.linesVersion)
    expect(stream.lines.value).toEqual(["new-1"])

    feed.close()
    await done
  })

  it("surfaces an ApiError message and falls back for unknown errors", async () => {
    mockedFetch.mockImplementation(() => Promise.reject(new ApiError(403, "logs forbidden")))
    const stream = useInHost()
    await stream.start("/url")
    expect(stream.error.value).toBe("logs forbidden")
    expect(stream.running.value).toBe(false)

    mockedFetch.mockImplementation(() => Promise.reject(new Error("network down")))
    await stream.start("/url")
    expect(stream.error.value).toBe("Log stream failed.")
  })

  it("drops a stale chunk from a superseded stream after a restart", async () => {
    // First stream stays open; we deliver a chunk to it only after a second
    // start() has begun — the generation guard must discard it so it can never
    // land in (or clobber) the new stream's lines.
    let staleCtrl!: ReadableStreamDefaultController<Uint8Array>
    const staleBody = new ReadableStream<Uint8Array>({
      start(c) {
        staleCtrl = c
      },
    })
    mockedFetch.mockResolvedValueOnce(new Response(staleBody))
    mockedFetch.mockResolvedValueOnce(streamResponse(["fresh-line\n"]))

    const stream = useInHost()
    const first = stream.start("/podA/log")
    // Let start() reach its first reader.read() on the stale stream.
    await Promise.resolve()
    await Promise.resolve()

    // Switch pods: second stream supersedes the first.
    await stream.start("/podB/log")

    // The stale stream now yields a late chunk and closes.
    staleCtrl.enqueue(encoder.encode("stale-line\n"))
    staleCtrl.close()
    await first

    expect(stream.lines.value).toEqual(["fresh-line"])
    expect(stream.error.value).toBeNull()
    expect(stream.running.value).toBe(false)
  })

  // The bug this covers: a followed stream left open in a background tab is
  // eventually dropped by whatever sits between the browser and the kubelet (an
  // ingress read timeout, a load balancer, --streaming-connection-idle-timeout),
  // and the viewer answered with "Log stream failed." and stopped for good.
  it("reconnects a dropped follow stream and resumes from the last line", async () => {
    const feed = manualResponse()
    mockedFetch.mockResolvedValueOnce(feed.resp)
    mockedFetch.mockResolvedValueOnce(streamResponse(["b\n"]))
    const stream = useInHost()
    const resume = vi.fn((sinceSeconds: number | null) => `/url?sinceSeconds=${sinceSeconds}`)
    // Sync flush: `reconnecting` is transient by design and a default watcher
    // would only ever see the value it settles on.
    const seen: (string | null)[] = []
    watch(stream.reconnecting, (v) => seen.push(v), { flush: "sync" })

    const done = stream.start("/url?follow=true", { resume })
    feed.push("a\n")
    await nextFlush(stream.linesVersion)
    feed.fail(new TypeError("Failed to fetch"))
    await done

    // The reconnect continues the same buffer instead of replacing it.
    expect(stream.lines.value).toEqual(["a", "b"])
    expect(stream.error.value).toBeNull()
    expect(resume).toHaveBeenCalledTimes(1)
    // A whole-second window measured from the last line that arrived, padded so
    // the seam duplicates a line rather than losing one.
    expect(resume.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(1)
    expect(mockedFetch.mock.calls[1]?.[0]).toBe(`/url?sinceSeconds=${resume.mock.calls[0]?.[0]}`)
    // The drop was stated while it was being retried, and is over now.
    expect(seen).toContain("Log stream failed.")
    expect(stream.reconnecting.value).toBeNull()
  })

  it("does not reconnect after a clean end of stream", async () => {
    // How the endpoint says there is no more log to follow — the container
    // terminated, or previous=true reached the end of a finished one. Retrying
    // would re-read the same log forever.
    mockedFetch.mockResolvedValueOnce(streamResponse(["only\n"]))
    const stream = useInHost()
    const resume = vi.fn(() => "/resume")

    await stream.start("/url?follow=true", { resume })

    expect(resume).not.toHaveBeenCalled()
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    expect(stream.error.value).toBeNull()
    expect(stream.running.value).toBe(false)
  })

  it("does not reconnect a failure the apiserver decided", async () => {
    mockedFetch.mockRejectedValue(new ApiError(404, 'pods "p" not found'))
    const stream = useInHost()
    const resume = vi.fn(() => "/resume")

    await stream.start("/url?follow=true", { resume })

    expect(resume).not.toHaveBeenCalled()
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    expect(stream.error.value).toBe('pods "p" not found')
    expect(stream.reconnecting.value).toBeNull()
  })

  it("stop() ends a pending reconnect instead of leaving it armed", async () => {
    // Two failures in a row, so the loop is inside the backoff wait (the first
    // retry is immediate, the second is a second away) when stop() lands.
    mockedFetch.mockRejectedValue(new TypeError("Failed to fetch"))
    const stream = useInHost()
    const done = stream.start("/url?follow=true", { resume: () => "/resume" })
    for (let i = 0; i < 100 && mockedFetch.mock.calls.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(mockedFetch).toHaveBeenCalledTimes(2)

    stream.stop()
    await done

    expect(mockedFetch).toHaveBeenCalledTimes(2)
    expect(stream.running.value).toBe(false)
    expect(stream.reconnecting.value).toBeNull()
    expect(stream.error.value).toBeNull()
  })

  it("stop() aborts without reporting an error", async () => {
    let rejectFetch!: (e: unknown) => void
    mockedFetch.mockImplementation(
      (_path, init) =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          )
        }),
    )
    const stream = useInHost()
    const started = stream.start("/url")
    stream.stop() // aborts the in-flight request
    void rejectFetch // rejection happens via the abort listener
    await started

    expect(stream.error.value).toBeNull()
    expect(stream.running.value).toBe(false)
  })
})
