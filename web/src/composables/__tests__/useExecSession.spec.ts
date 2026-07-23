import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"

import { setCredentialProvider } from "@/api/http"
import { useExecSession, type ExecHandlers } from "@/composables/useExecSession"

const SENTINEL = "SENTINEL-exec-token"

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  url: string
  binaryType = "blob"
  readyState = MockWebSocket.CONNECTING
  sent: Array<string | Uint8Array> = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }
}

function setupSession(handlers?: Partial<ExecHandlers>) {
  let session!: ReturnType<typeof useExecSession>
  const output: Uint8Array[] = []
  const exits: Array<number | null> = []
  const Host = defineComponent({
    setup() {
      session = useExecSession({
        onOutput: (data) => {
          output.push(data)
          handlers?.onOutput?.(data)
        },
        onExit: (code) => {
          exits.push(code)
          handlers?.onExit?.(code)
        },
      })
      return () => h("div")
    },
  })
  const wrapper = mount(Host)
  return { session, output, exits, wrapper }
}

describe("useExecSession", () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal("WebSocket", MockWebSocket)
    setCredentialProvider({
      async getBearerToken() {
        return SENTINEL
      },
      getContext() {
        return "beta"
      },
      async logout() {},
    })
  })

  afterEach(() => {
    setCredentialProvider(null)
    vi.unstubAllGlobals()
  })

  async function startedSession() {
    const ctx = setupSession()
    await ctx.session.start({
      namespace: "default",
      pod: "api-1",
      container: "app",
      command: ["/bin/sh"],
    })
    const socket = MockWebSocket.instances[0]
    expect(socket).toBeDefined()
    return { ...ctx, socket: socket as MockWebSocket }
  }

  it("never puts the token into the WebSocket URL", async () => {
    const { socket } = await startedSession()
    expect(socket.url).toContain("/api/ui/exec/ws")
    expect(socket.url).not.toContain(SENTINEL)
    expect(socket.url).not.toContain("token")
  })

  it("sends the auth frame first, as text", async () => {
    const { socket } = await startedSession()
    socket.open()
    expect(socket.sent.length).toBe(1)
    const first = socket.sent[0]
    expect(typeof first).toBe("string")
    const frame = JSON.parse(first as string) as Record<string, unknown>
    expect(frame.type).toBe("auth")
    expect(frame.token).toBe(SENTINEL)
    expect(frame.context).toBe("beta")
    expect(frame.namespace).toBe("default")
    expect(frame.pod).toBe("api-1")
    expect(frame.command).toEqual(["/bin/sh"])
  })

  it("sends stdin as binary frames and resize as text frames", async () => {
    const { session, socket } = await startedSession()
    socket.open()
    socket.onmessage?.({ data: JSON.stringify({ type: "ready" }) })
    expect(session.status.value).toBe("ready")

    session.sendInput("ls -la\n")
    const stdin = socket.sent[1]
    // Binary, not text (cross-realm safe check).
    expect(typeof stdin).not.toBe("string")
    expect(ArrayBuffer.isView(stdin)).toBe(true)
    expect(new TextDecoder().decode(stdin as Uint8Array)).toBe("ls -la\n")

    session.sendResize(120, 40)
    const resize = socket.sent[2]
    expect(typeof resize).toBe("string")
    expect(JSON.parse(resize as string)).toEqual({ type: "resize", cols: 120, rows: 40 })
  })

  it("routes binary frames to onOutput", async () => {
    const { output, socket } = await startedSession()
    socket.open()
    const payload = new TextEncoder().encode("hello from pod").buffer
    socket.onmessage?.({ data: payload })
    expect(output.length).toBe(1)
    expect(new TextDecoder().decode(output[0])).toBe("hello from pod")
  })

  it("handles error and exit control frames", async () => {
    const { session, socket } = await startedSession()
    socket.open()
    socket.onmessage?.({ data: JSON.stringify({ type: "error", message: "pods/exec forbidden" }) })
    expect(session.status.value).toBe("error")
    expect(session.errorMessage.value).toContain("forbidden")

    const second = setupSession()
    await second.session.start({ namespace: "ns", pod: "p", container: "", command: ["/bin/sh"] })
    const socket2 = MockWebSocket.instances[1] as MockWebSocket
    socket2.open()
    socket2.onmessage?.({ data: JSON.stringify({ type: "exit", code: 42 }) })
    expect(second.session.status.value).toBe("closed")
    expect(second.exits).toEqual([42])
  })

  it("closes the socket on unmount", async () => {
    const { wrapper, socket } = await startedSession()
    socket.open()
    wrapper.unmount()
    expect(socket.readyState).toBe(MockWebSocket.CLOSED)
  })

  it("does not open a socket when unmounted during the token await", async () => {
    let resolveToken!: (t: string) => void
    setCredentialProvider({
      getBearerToken: () => new Promise<string>((r) => (resolveToken = r)),
      getContext: () => null,
      async logout() {},
    })
    const ctx = setupSession()
    const startPromise = ctx.session.start({
      namespace: "default",
      pod: "api-1",
      container: "app",
      command: ["/bin/sh"],
    })
    // Unmount (→ stop()) before the token resolves.
    ctx.wrapper.unmount()
    resolveToken(SENTINEL)
    await startPromise
    // The post-await guard must have prevented socket creation.
    expect(MockWebSocket.instances).toHaveLength(0)
  })
})
