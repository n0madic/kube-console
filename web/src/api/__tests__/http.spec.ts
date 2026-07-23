import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ApiError,
  apiFetch,
  setCredentialProvider,
  setUnauthorizedHandler,
  setUnknownContextHandler,
} from "@/api/http"
import type { CredentialProvider } from "@/auth/CredentialProvider"

function fakeProvider(
  token: string | null,
  context: string | null = null,
): CredentialProvider & {
  loggedOut: boolean
  loggedOutContext: string | undefined
  context: string | null
} {
  return {
    loggedOut: false,
    loggedOutContext: undefined,
    // Mutable: one provider outlives a cluster switch, exactly like the real one.
    context,
    async getBearerToken() {
      return token
    },
    getContext() {
      return this.context
    },
    async logout(ended?: string) {
      this.loggedOut = true
      this.loggedOutContext = ended
    },
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

afterEach(() => {
  setCredentialProvider(null)
  setUnauthorizedHandler(null)
  setUnknownContextHandler(null)
  vi.unstubAllGlobals()
})

describe("apiFetch", () => {
  it("attaches the bearer token from the provider", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(200, { ok: true }),
    )
    vi.stubGlobal("fetch", fetchMock)
    setCredentialProvider(fakeProvider("tok-123"))

    await apiFetch("/api/ui/discovery")

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok-123")
  })

  it("injects the active context as X-Kube-Context", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(200, { ok: true }),
    )
    vi.stubGlobal("fetch", fetchMock)
    setCredentialProvider(fakeProvider("tok-123", "beta"))

    await apiFetch("/k8s/api/v1/pods")

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get("X-Kube-Context")).toBe("beta")
  })

  it("omits X-Kube-Context for the default (null) context", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(200, { ok: true }),
    )
    vi.stubGlobal("fetch", fetchMock)
    setCredentialProvider(fakeProvider("tok-123", null))

    await apiFetch("/k8s/api/v1/pods")

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).has("X-Kube-Context")).toBe(false)
  })

  it("keeps a caller-supplied Authorization header over the provider token", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(200, { ok: true }),
    )
    vi.stubGlobal("fetch", fetchMock)
    setCredentialProvider(fakeProvider("session-token"))

    await apiFetch("/api/ui/auth/verify", {
      method: "POST",
      headers: { Authorization: "Bearer candidate-token" },
    })

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer candidate-token")
  })

  it("logs out and calls the unauthorized handler on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(401, { kind: "Status", status: "Failure", message: "expired", code: 401 }),
      ),
    )
    const provider = fakeProvider("tok-123")
    const onUnauthorized = vi.fn()
    setCredentialProvider(provider)
    setUnauthorizedHandler(onUnauthorized)

    await expect(apiFetch("/k8s/api/v1/pods")).rejects.toMatchObject({ status: 401 })
    expect(provider.loggedOut).toBe(true)
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  // Regression: a response can land after the user switched clusters. Both the
  // logout and the handler must name the context the request was SENT to, not
  // whatever is active by the time it fails — otherwise a late 401 from the old
  // cluster ends the session of the new one.
  it("reports the request's own context on 401, even after a context switch", async () => {
    let resolveFetch: (r: Response) => void = () => {}
    let markCalled: () => void = () => {}
    const inFlight = new Promise<void>((resolve) => {
      markCalled = resolve
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
        markCalled()
        return await response
      }),
    )
    const provider = fakeProvider("tok-alpha", "alpha")
    const onUnauthorized = vi.fn()
    setCredentialProvider(provider)
    setUnauthorizedHandler(onUnauthorized)

    const pending = apiFetch("/k8s/api/v1/pods")
    await inFlight
    // The user switches clusters while the request is in flight.
    provider.context = "beta"
    resolveFetch(jsonResponse(401, { kind: "Status", status: "Failure", code: 401 }))

    await expect(pending).rejects.toMatchObject({ status: 401 })
    expect(provider.loggedOutContext).toBe("alpha")
    expect(onUnauthorized).toHaveBeenCalledWith("alpha")
  })

  it("passes the empty context when the request carried no context header", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, {})))
    const provider = fakeProvider("tok-123", null)
    const onUnauthorized = vi.fn()
    setCredentialProvider(provider)
    setUnauthorizedHandler(onUnauthorized)

    await expect(apiFetch("/k8s/api/v1/pods")).rejects.toMatchObject({ status: 401 })
    expect(provider.loggedOutContext).toBe("")
    expect(onUnauthorized).toHaveBeenCalledWith("")
  })

  it("does not trigger logout when skipUnauthorizedHandler is set", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, {})))
    const provider = fakeProvider(null)
    const onUnauthorized = vi.fn()
    setCredentialProvider(provider)
    setUnauthorizedHandler(onUnauthorized)

    await expect(
      apiFetch("/api/ui/auth/verify", { method: "POST", skipUnauthorizedHandler: true }),
    ).rejects.toBeInstanceOf(ApiError)
    expect(provider.loggedOut).toBe(false)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  const unknownContextStatus = {
    kind: "Status",
    status: "Failure",
    message: "unknown cluster context",
    code: 400,
  }

  it("calls the unknown-context handler on the backend's 400 message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, unknownContextStatus)))
    const onUnknownContext = vi.fn()
    setCredentialProvider(fakeProvider("tok-123", "ghost"))
    setUnknownContextHandler(onUnknownContext)

    await expect(apiFetch("/k8s/api/v1/pods")).rejects.toMatchObject({ status: 400 })
    // Named, so a reset can be skipped when the rejected context is no longer
    // the active one.
    expect(onUnknownContext).toHaveBeenCalledWith("ghost")
  })

  // Regression: the login flow opts out of session-mutating global handlers;
  // a verify against a removed context must not reset the active context.
  it("does not call the unknown-context handler when skipUnauthorizedHandler is set", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, unknownContextStatus)))
    const onUnknownContext = vi.fn()
    setCredentialProvider(fakeProvider(null, "ghost"))
    setUnknownContextHandler(onUnknownContext)

    await expect(
      apiFetch("/api/ui/auth/verify", { method: "POST", skipUnauthorizedHandler: true }),
    ).rejects.toBeInstanceOf(ApiError)
    expect(onUnknownContext).not.toHaveBeenCalled()
  })

  it("ignores unrelated 400s (no unknown-context message)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, { kind: "Status", status: "Failure", message: "bad request", code: 400 }),
      ),
    )
    const onUnknownContext = vi.fn()
    setCredentialProvider(fakeProvider("tok-123", "beta"))
    setUnknownContextHandler(onUnknownContext)

    await expect(apiFetch("/k8s/api/v1/pods")).rejects.toMatchObject({ status: 400 })
    expect(onUnknownContext).not.toHaveBeenCalled()
  })

  it("surfaces the Kubernetes Status body in ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(403, {
          kind: "Status",
          status: "Failure",
          message: 'pods is forbidden: User "jane" cannot list',
          reason: "Forbidden",
          code: 403,
        }),
      ),
    )
    setCredentialProvider(fakeProvider("tok"))

    try {
      await apiFetch("/k8s/api/v1/pods")
      expect.unreachable()
    } catch (e) {
      const err = e as ApiError
      expect(err.status).toBe(403)
      expect(err.k8sStatus?.reason).toBe("Forbidden")
      expect(err.message).toContain("forbidden")
    }
  })
})
