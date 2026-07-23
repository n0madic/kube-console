// Exec WebSocket session: same-origin WSS, token only in the first auth
// frame (never in the URL), binary stdin/stdout, JSON control frames.

import { onBeforeUnmount, ref } from "vue"

import { getCredentialProvider } from "@/api/http"

export interface ExecTarget {
  namespace: string
  pod: string
  container: string
  command: string[]
}

export type ExecStatus = "idle" | "connecting" | "ready" | "closed" | "error"

export interface ExecHandlers {
  onOutput: (data: Uint8Array) => void
  onExit?: (code: number | null) => void
}

interface ControlFrame {
  type: "ready" | "error" | "exit"
  message?: string
  code?: number
}

const encoder = new TextEncoder()

export function useExecSession(handlers: ExecHandlers) {
  const status = ref<ExecStatus>("idle")
  const errorMessage = ref<string | null>(null)

  let ws: WebSocket | null = null
  // Bumped on every start()/stop(). getBearerToken() is async, so a stop()
  // (or unmount, or a newer start()) during that await must prevent this call
  // from opening a socket that nothing would ever close.
  let gen = 0

  async function start(target: ExecTarget): Promise<void> {
    stop()
    const myGen = ++gen
    status.value = "connecting"
    errorMessage.value = null

    const provider = getCredentialProvider()
    const token = provider !== null ? await provider.getBearerToken() : null
    const context = provider !== null ? provider.getContext() : null
    // Stopped/unmounted/superseded while awaiting the token: do not connect.
    if (myGen !== gen) return
    if (token === null || token === "") {
      status.value = "error"
      errorMessage.value = "Not authenticated."
      return
    }

    const scheme = window.location.protocol === "https:" ? "wss" : "ws"
    const socket = new WebSocket(`${scheme}://${window.location.host}/api/ui/exec/ws`)
    socket.binaryType = "arraybuffer"
    ws = socket

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "auth",
          token,
          // Carry the active cluster alongside the token (empty → default).
          ...(context !== null && context !== "" ? { context } : {}),
          namespace: target.namespace,
          pod: target.pod,
          container: target.container,
          command: target.command,
        }),
      )
    }

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        let frame: ControlFrame
        try {
          frame = JSON.parse(event.data) as ControlFrame
        } catch {
          return
        }
        switch (frame.type) {
          case "ready":
            status.value = "ready"
            break
          case "error":
            status.value = "error"
            errorMessage.value = frame.message ?? "exec failed"
            break
          case "exit":
            status.value = "closed"
            handlers.onExit?.(frame.code ?? null)
            break
        }
        return
      }
      handlers.onOutput(new Uint8Array(event.data as ArrayBuffer))
    }

    socket.onclose = () => {
      if (status.value !== "error") status.value = "closed"
      if (ws === socket) ws = null
    }
    socket.onerror = () => {
      if (status.value === "connecting") {
        status.value = "error"
        errorMessage.value = "WebSocket connection failed."
      }
    }
  }

  function sendInput(data: string): void {
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      ws.send(encoder.encode(data))
    }
  }

  function sendResize(cols: number, rows: number): void {
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols, rows }))
    }
  }

  function stop(): void {
    gen += 1
    const socket = ws
    ws = null
    if (socket !== null) {
      // Detach every handler before closing: a frame buffered on the CLOSING
      // socket can still fire onmessage and write the previous session's bytes
      // into the terminal shared with the next session.
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      socket.close()
    }
    if (status.value === "connecting" || status.value === "ready") {
      status.value = "closed"
    }
  }

  onBeforeUnmount(stop)

  return { status, errorMessage, start, stop, sendInput, sendResize }
}
