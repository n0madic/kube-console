// The app entry's global 401 handling, end to end through the real router and
// the real store — the wiring lives in main.ts by design (see CLAUDE.md), so
// this drives it the way a failing request does rather than re-implementing it.
//
// In the local kubeconfig mode a 401 means the apiserver rejected the BACKEND's
// credentials: there is no session to end and nothing to re-enter on the login
// page, so neither the sign-out nor the redirect may fire.

import { beforeEach, describe, expect, it, vi } from "vitest"

// The whole component tree is irrelevant here and would fire its own queries.
vi.mock("@/App.vue", () => ({ default: { name: "AppStub", template: "<div />" } }))

const SESSION_KEY = "kube-console.session.v1"
const SENTINEL = "SENTINEL-token-must-survive-local-mode"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** Boot main.ts against a backend in the given auth mode; everything else 401s. */
async function boot(mode: "kubeconfig" | "token"): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/ui/auth/mode") return jsonResponse(200, { mode })
      return jsonResponse(401, { kind: "Status", status: "Failure", code: 401 })
    }),
  )
  await import("@/main")
  // bootstrap() awaits the mode before mounting; let it settle.
  await vi.waitFor(async () => {
    const { useAuthStore } = await import("@/stores/auth")
    expect(useAuthStore().localAuth).toBe(mode === "kubeconfig")
  })
}

describe("main.ts unauthorized handling", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
    window.localStorage.clear()
    document.body.innerHTML = '<div id="app"></div>'
    window.history.replaceState({}, "", "/overview")
    // A live session, so the route guard leaves us on /overview and a 401 is
    // the only thing that can move us.
    window.sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        activeContext: "default",
        sessions: {
          default: {
            token: SENTINEL,
            identity: null,
            identityUnavailable: false,
            expiresAt: Date.now() + 60 * 60 * 1000,
          },
        },
      }),
    )
  })

  it("neither ends a session nor redirects in the local kubeconfig mode", async () => {
    await boot("kubeconfig")
    const { apiFetch } = await import("@/api/http")

    await expect(apiFetch("/k8s/api/v1/pods")).rejects.toMatchObject({ status: 401 })
    // Give a redirect time to happen — the login route is a lazy chunk, so
    // "did not navigate" is only a real assertion once that import could have
    // resolved.
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(window.location.pathname).toBe("/overview")
    expect(window.sessionStorage.getItem(SESSION_KEY)).toContain(SENTINEL)
  })

  // Regression: the mode probe gates app.mount(), so a backend that accepts the
  // connection and then never answers must not be able to hold the page blank.
  // It times out into token mode, i.e. onto the login page.
  it("mounts anyway when the mode probe never answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            // Never settles on its own; only the caller's abort signal ends it.
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
          }),
      ),
    )
    await import("@/main")

    await vi.waitFor(
      () => expect(document.querySelector("#app")?.innerHTML).not.toBe(""),
      { timeout: 10000 },
    )
    const { useAuthStore } = await import("@/stores/auth")
    expect(useAuthStore().localAuth).toBe(false)
  }, 15000)

  // Control: the normal mode still signs out and shows the login page.
  it("ends the session and redirects to login in token mode", async () => {
    await boot("token")
    const { apiFetch } = await import("@/api/http")

    await expect(apiFetch("/k8s/api/v1/pods")).rejects.toMatchObject({ status: 401 })
    await vi.waitFor(() => expect(window.location.pathname).toBe("/login"))

    expect(window.sessionStorage.getItem(SESSION_KEY) ?? "").not.toContain(SENTINEL)
  })

  // Regression: the query pruner matched ANY element of the key
  // (`queryKey.includes(context)`), so ending the "default" context's session
  // also evicted another, still signed-in cluster's cached responses whenever
  // some other slot happened to hold that name — a Pod Env entry for namespace
  // "default", say. The context lives in slot 1 of every context-scoped key.
  it("prunes only the ended context's queries, by the context slot", async () => {
    const { QueryClient } = await import("@tanstack/vue-query")
    const removeQueries = vi.spyOn(QueryClient.prototype, "removeQueries")

    await boot("token")
    const { apiFetch } = await import("@/api/http")
    await expect(apiFetch("/k8s/api/v1/pods")).rejects.toMatchObject({ status: 401 })
    await vi.waitFor(() => expect(removeQueries).toHaveBeenCalled())

    const filters = removeQueries.mock.calls.at(-1)?.[0] as
      | { predicate?: (q: { queryKey: readonly unknown[] }) => boolean }
      | undefined
    const matches = filters?.predicate
    expect(matches).toBeTypeOf("function")

    // The ended context's own entries go.
    expect(matches!({ queryKey: ["discovery", "default"] })).toBe(true)
    expect(matches!({ queryKey: ["podEnvSource", "default", "kube-system", "secrets", []] })).toBe(
      true,
    )
    // Another cluster's entries stay — even when a later slot is called
    // "default" (a namespace of that name is entirely ordinary).
    expect(matches!({ queryKey: ["podEnvSource", "prod", "default", "secrets", []] })).toBe(false)
    expect(matches!({ queryKey: ["discovery", "prod"] })).toBe(false)
    // And the context list itself is not context-scoped at all.
    expect(matches!({ queryKey: ["contexts"] })).toBe(false)

    removeQueries.mockRestore()
  })
})

// The unknown-context recovery, driven the way a failing request drives it.
//
// Regression: the handler reset the active context to `""` whenever the cached
// ["contexts"] entry was missing — three lines under a comment forbidding that
// value, because sessions are keyed by resolved names, so `""` resolves to no
// session and orphans every still-valid one. The cache miss is guaranteed in
// exactly this state: fetching the context list carries the rejected
// X-Kube-Context too, so on a reload it has failed just like this request. And
// nothing routed anywhere, leaving the app on a protected view with every
// context-scoped query gated off.
describe("main.ts unknown-context handling", () => {
  const UNKNOWN_CONTEXT_MESSAGE = "unknown cluster context"
  const OTHER_SENTINEL = "SENTINEL-other-cluster-token"

  /** Boots token mode where every /k8s request is rejected as an unknown context. */
  async function bootUnknownContext(): Promise<() => number> {
    let rejections = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === "/api/ui/auth/mode") return jsonResponse(200, { mode: "token" })
        rejections++
        return jsonResponse(400, {
          kind: "Status",
          status: "Failure",
          message: UNKNOWN_CONTEXT_MESSAGE,
          code: 400,
        })
      }),
    )
    await import("@/main")
    await vi.waitFor(async () => {
      const { useAuthStore } = await import("@/stores/auth")
      expect(useAuthStore().localAuth).toBe(false)
    })
    return () => rejections
  }

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
    window.localStorage.clear()
    document.body.innerHTML = '<div id="app"></div>'
    window.history.replaceState({}, "", "/overview")
    // Signed into the removed cluster AND into another one that must survive.
    window.sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        activeContext: "prod-old",
        sessions: {
          "prod-old": {
            token: SENTINEL,
            identity: null,
            identityUnavailable: false,
            expiresAt: Date.now() + 60 * 60 * 1000,
          },
          staging: {
            token: OTHER_SENTINEL,
            identity: null,
            identityUnavailable: false,
            expiresAt: Date.now() + 60 * 60 * 1000,
          },
        },
      }),
    )
  })

  it("keeps a valid session for another cluster reachable and lands on login", async () => {
    await bootUnknownContext()
    const { apiFetch } = await import("@/api/http")
    const { useAuthStore } = await import("@/stores/auth")

    await expect(apiFetch("/k8s/api/v1/pods")).rejects.toMatchObject({ status: 400 })
    await vi.waitFor(() => expect(window.location.pathname).toBe("/login"))

    const auth = useAuthStore()
    // Never "": that is what orphaned the other cluster's session.
    expect(auth.activeContext).not.toBe("")
    // The still-valid cluster is offered as a way back in.
    expect(auth.signedInContexts()).toContain("staging")
    expect(window.sessionStorage.getItem(SESSION_KEY)).toContain(OTHER_SENTINEL)
    // The rejected cluster's token is gone: no request can spend it any more.
    expect(window.sessionStorage.getItem(SESSION_KEY) ?? "").not.toContain(SENTINEL)
  })

  // Regression: with the fallback default itself rejected, the handler wrote the
  // same name back (no state change), invalidated ["contexts"], and that refetch
  // 400'd straight back into the handler — a request loop with no backoff,
  // bounded only by the user navigating away.
  it("does not loop when the fallback default is rejected too", async () => {
    const rejections = await bootUnknownContext()
    const { apiFetch } = await import("@/api/http")
    const { QueryClient } = await import("@tanstack/vue-query")
    const { useAuthStore } = await import("@/stores/auth")

    // A cached list naming the active context as the default: the recovery has
    // nowhere else to go.
    useAuthStore().setActiveContext("prod-old")
    QueryClient.prototype.getQueryData = function () {
      return { contexts: [{ name: "prod-old" }], default: "prod-old" }
    } as typeof QueryClient.prototype.getQueryData

    await expect(apiFetch("/k8s/api/v1/pods")).rejects.toMatchObject({ status: 400 })
    const afterFirst = rejections()
    // Long enough for a refetch-driven loop to show itself.
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(rejections()).toBe(afterFirst)
    expect(window.location.pathname).toBe("/login")
  })
})

// Regression: installing the router — not app.mount — is what starts the first
// navigation, so awaiting the auth-mode probe before mounting left the guard
// deciding with localAuth still false. In the kubeconfig mode there is no
// session for isAuthenticated to fall back on, so the guard redirected to a
// login page that mode says does not exist, and no later navigation corrected
// it: the user landed on a login form on every page load, and picking any
// context walked straight back into the app. The race made it intermittent —
// an immediately-resolved probe could win — so the probe here answers a
// macrotask later, the way a real round trip does.
describe("main.ts auth mode before the first navigation", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
    window.localStorage.clear()
    document.body.innerHTML = '<div id="app"></div>'
    window.history.replaceState({}, "", "/overview")
  })

  it("does not send a kubeconfig-mode user to login while the mode is unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/ui/auth/mode") {
          await new Promise((resolve) => setTimeout(resolve, 20))
          return jsonResponse(200, { mode: "kubeconfig" })
        }
        return jsonResponse(200, { kind: "Status", items: [] })
      }),
    )

    await import("@/main")
    await vi.waitFor(async () => {
      const { useAuthStore } = await import("@/stores/auth")
      expect(useAuthStore().localAuth).toBe(true)
    })
    // Long enough for a redirect (a lazily imported route chunk) to land.
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(window.location.pathname).toBe("/overview")
  })
})
