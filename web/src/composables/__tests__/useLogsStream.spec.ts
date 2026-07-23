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
    watch(stream.lines, () => updates++)

    await stream.start("/url")
    await nextTick()

    expect(stream.lines.value).toHaveLength(50)
    // One reset to [] on start plus the final flush — never one per chunk.
    expect(updates).toBeLessThanOrEqual(2)
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
