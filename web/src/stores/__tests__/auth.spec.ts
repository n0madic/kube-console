// Session invariants: tokens are tab-scoped (sessionStorage with TTL), one per
// kubeconfig context, and must never reach localStorage or the serialized
// preferences. clearSession(context) is the single end-of-session path (Sign
// out, 401, TTL): it drops one context so other clusters stay signed in, and
// keeps the active context name. pruneExpiredSessions() is its TTL form — an
// expired token must not sit in storage waiting for a reload.

import { QueryClient } from "@tanstack/vue-query"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"

import {
  SESSION_STORAGE_KEY,
  SESSION_TTL_MS,
  setQueryPruner,
  useAuthStore,
} from "@/stores/auth"
import {
  PREFS_STORAGE_KEY,
  serializePreferences,
  usePreferencesStore,
} from "@/stores/preferences"
import { getMetricsBuffer } from "@/utils/metricsCache"

const SENTINEL = "SENTINEL-bearer-token-must-not-persist"
const SENTINEL_B = "SENTINEL-bearer-token-cluster-b"

describe("auth store", () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    setActivePinia(createPinia())
    // Module-level injection (main.ts wires the real one): unregister so a
    // pruner from one test cannot fire in the next.
    setQueryPruner(null)
  })

  /** The pruner main.ts installs, over a throwaway client. */
  function withQueryCache(): QueryClient {
    const queryClient = new QueryClient()
    setQueryPruner((context) => {
      queryClient.removeQueries({ predicate: (q) => q.queryKey.includes(context) })
    })
    return queryClient
  }

  it("never lets any context token reach localStorage", async () => {
    const auth = useAuthStore()
    const prefs = usePreferencesStore()

    auth.setSession("alpha", SENTINEL, { username: "jane" }, false)
    auth.setSession("beta", SENTINEL_B, { username: "jane" }, false)
    // Mutate preferences so the persistence watcher definitely fires.
    prefs.prefs.theme = "dark"
    prefs.togglePinned("core/v1/pods")
    await nextTick()

    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      expect(key).not.toBeNull()
      const value = window.localStorage.getItem(key as string) ?? ""
      expect(value).not.toContain(SENTINEL)
      expect(value).not.toContain(SENTINEL_B)
    }
  })

  it("resolves getters against the active context", () => {
    const auth = useAuthStore()
    auth.setSession("alpha", SENTINEL, { username: "alice" }, false)
    auth.setSession("beta", SENTINEL_B, { username: "bob" }, true)

    // setSession activates the last-set context.
    expect(auth.activeContext).toBe("beta")
    expect(auth.token).toBe(SENTINEL_B)
    expect(auth.identity?.username).toBe("bob")
    expect(auth.identityUnavailable).toBe(true)

    auth.setActiveContext("alpha")
    expect(auth.token).toBe(SENTINEL)
    expect(auth.identity?.username).toBe("alice")
    expect(auth.identityUnavailable).toBe(false)
    expect(auth.isAuthenticated).toBe(true)
  })

  it("mirrors sessions into sessionStorage with a TTL", () => {
    const auth = useAuthStore()
    const before = Date.now()
    auth.setSession("alpha", SENTINEL, { username: "jane" }, false)

    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw as string) as {
      activeContext: string
      sessions: Record<string, { token: string; expiresAt: number } | undefined>
    }
    expect(stored.activeContext).toBe("alpha")
    const alpha = stored.sessions.alpha
    expect(alpha).toBeDefined()
    expect(alpha?.token).toBe(SENTINEL)
    expect(alpha?.expiresAt).toBeGreaterThanOrEqual(before + SESSION_TTL_MS - 1000)
    expect(alpha?.expiresAt).toBeLessThanOrEqual(Date.now() + SESSION_TTL_MS + 1000)
  })

  it("restores per-context sessions after a reload (new pinia)", () => {
    const auth = useAuthStore()
    auth.setSession("alpha", SENTINEL, { username: "jane" }, true)
    auth.setSession("beta", SENTINEL_B, { username: "bob" }, false)
    auth.setActiveContext("alpha")

    // Simulate a page reload: fresh pinia, same sessionStorage.
    setActivePinia(createPinia())
    const restored = useAuthStore()
    expect(restored.activeContext).toBe("alpha")
    expect(restored.token).toBe(SENTINEL)
    expect(restored.identity?.username).toBe("jane")
    expect(restored.identityUnavailable).toBe(true)
    restored.setActiveContext("beta")
    expect(restored.token).toBe(SENTINEL_B)
  })

  it("ignores and drops an expired stored session, keeping valid ones", () => {
    window.sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        activeContext: "alpha",
        sessions: {
          alpha: { token: SENTINEL, identity: null, identityUnavailable: false, expiresAt: Date.now() - 1000 },
          beta: { token: SENTINEL_B, identity: null, identityUnavailable: false, expiresAt: Date.now() + SESSION_TTL_MS },
        },
      }),
    )
    const auth = useAuthStore()
    // alpha expired → not authenticated while active…
    expect(auth.isAuthenticated).toBe(false)
    // …but beta survived.
    auth.setActiveContext("beta")
    expect(auth.token).toBe(SENTINEL_B)
  })

  // Backs the "signed in" mark in the cluster switcher.
  it("hasSession reports a usable token per context, and stops at the TTL", () => {
    const auth = useAuthStore()
    auth.setSession("alpha", SENTINEL, null, false)

    expect(auth.hasSession("alpha")).toBe(true)
    expect(auth.hasSession("beta")).toBe(false)
    expect(auth.hasSession("__proto__")).toBe(false)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000)
      expect(auth.hasSession("alpha")).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  // Backs the login page's "go back to a signed-in cluster" escape hatch.
  it("signedInContexts lists the usable sessions and drops expired ones", () => {
    const auth = useAuthStore()
    auth.setSession("beta", SENTINEL_B, null, false)
    auth.setSession("alpha", SENTINEL, null, false)

    expect(auth.signedInContexts()).toEqual(["alpha", "beta"])

    auth.clearActiveSession()
    expect(auth.signedInContexts()).toEqual(["beta"])

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000)
      expect(auth.signedInContexts()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("drops a malformed identity from a tampered stored session", () => {
    window.sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        activeContext: "alpha",
        sessions: {
          alpha: { token: SENTINEL, identity: 42, identityUnavailable: false, expiresAt: Date.now() + SESSION_TTL_MS },
        },
      }),
    )
    const auth = useAuthStore()
    expect(auth.isAuthenticated).toBe(true)
    expect(auth.identity).toBeNull()
  })

  // Sign out is per-cluster: the token goes, the context name stays so the
  // login page can name the cluster being signed back into.
  it("clearActiveSession() keeps the context name and drops its stored token", () => {
    const auth = useAuthStore()
    auth.setSession("alpha", SENTINEL, { username: "jane" }, true)
    auth.clearActiveSession()

    expect(auth.token).toBeNull()
    expect(auth.isAuthenticated).toBe(false)
    expect(auth.activeContext).toBe("alpha")
    expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY) ?? "").not.toContain(SENTINEL)
  })

  it("clearActiveSession() drops only the active context, keeping others", () => {
    const auth = useAuthStore()
    auth.setSession("alpha", SENTINEL, { username: "alice" }, false)
    auth.setSession("beta", SENTINEL_B, { username: "bob" }, false)
    // beta is active; clearing it must not touch alpha.
    auth.clearActiveSession()
    expect(auth.isAuthenticated).toBe(false) // beta gone
    auth.setActiveContext("alpha")
    expect(auth.token).toBe(SENTINEL) // alpha survives
  })

  // Regression: ending ONE cluster's session (401/TTL) must not wipe another
  // still-signed-in cluster's chart history — the eviction is context-scoped.
  it("clearActiveSession() drops only the active context's metric series", () => {
    const auth = useAuthStore()
    auth.setSession("alpha", SENTINEL, null, false)
    auth.setSession("beta", SENTINEL_B, null, false) // beta active
    const alphaBuf = getMetricsBuffer("alpha:ns:default:cpu")
    alphaBuf.push(Date.now(), { total: 5 })
    const betaBuf = getMetricsBuffer("beta:ns:default:cpu")
    betaBuf.push(Date.now(), { total: 7 })

    auth.clearActiveSession()

    // beta's series is gone…
    const betaAfter = getMetricsBuffer("beta:ns:default:cpu")
    expect(betaAfter).not.toBe(betaBuf)
    expect(betaAfter.length).toBe(0)
    // …but alpha's history survives.
    expect(getMetricsBuffer("alpha:ns:default:cpu")).toBe(alphaBuf)
    expect(alphaBuf.length).toBe(1)
  })

  // Regression: an expired token must not linger in sessionStorage after a
  // reload — the restore scrubs dropped entries immediately (the old
  // single-session code removed the record on read).
  it("scrubs expired session records from sessionStorage on restore", () => {
    window.sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        activeContext: "alpha",
        sessions: {
          alpha: { token: SENTINEL, identity: null, identityUnavailable: false, expiresAt: Date.now() - 1000 },
        },
      }),
    )
    useAuthStore()
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY) ?? ""
    expect(raw).not.toContain(SENTINEL)
  })

  // Regression: hiding an expired session behind hasSession left the token
  // string itself in sessionStorage — readable by any same-origin script —
  // until a reload. Every path that uses or picks a session prunes instead.
  it("pruneExpiredSessions() erases expired tokens from storage, keeping valid ones", () => {
    const auth = useAuthStore()
    auth.setSession("alpha", SENTINEL, null, false)
    const alphaBuf = getMetricsBuffer("alpha:ns:default:cpu")
    alphaBuf.push(Date.now(), { total: 5 })

    vi.useFakeTimers()
    try {
      // alpha expires while the tab stays open; beta signs in afterwards.
      vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000)
      auth.setSession("beta", SENTINEL_B, null, false)

      expect(auth.pruneExpiredSessions()).toEqual(["alpha"])

      const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY) ?? ""
      expect(raw).not.toContain(SENTINEL)
      expect(raw).toContain(SENTINEL_B)
      expect(auth.signedInContexts()).toEqual(["beta"])
      // The expired cluster's chart history goes with its session.
      expect(getMetricsBuffer("alpha:ns:default:cpu")).not.toBe(alphaBuf)
      // Nothing to do the second time around.
      expect(auth.pruneExpiredSessions()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  // Regression: the TTL path dropped the token but left everything fetched with
  // it in the query cache — including the ConfigMap/Secret payloads the Pod Env
  // tab caches. Expiry must evict exactly what a sign-out evicts.
  it("pruneExpiredSessions() evicts the expired context's cached responses", () => {
    const auth = useAuthStore()
    const queryClient = withQueryCache()
    auth.setSession("alpha", SENTINEL, null, false)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000)
      auth.setSession("beta", SENTINEL_B, null, false)

      // A Secret payload read by the Env tab, plus an ordinary list, per cluster.
      const alphaEnv = ["podEnvSource", "alpha", "prod", "secrets", ["db"]]
      const betaEnv = ["podEnvSource", "beta", "prod", "secrets", ["db"]]
      queryClient.setQueryData(alphaEnv, { PASSWORD: "c3VwZXItc2VjcmV0" })
      queryClient.setQueryData(betaEnv, { PASSWORD: "YmV0YS1zZWNyZXQ=" })
      queryClient.setQueryData(["namespaces", "alpha"], ["default"])
      queryClient.setQueryData(["namespaces", "beta"], ["kube-system"])

      expect(auth.pruneExpiredSessions()).toEqual(["alpha"])

      // The expired cluster's cached Secret is gone, not merely unreachable.
      expect(queryClient.getQueryData(alphaEnv)).toBeUndefined()
      expect(queryClient.getQueryData(["namespaces", "alpha"])).toBeUndefined()
      // The still-valid cluster keeps its cache for an instant switch-back.
      expect(queryClient.getQueryData(betaEnv)).toEqual({ PASSWORD: "YmV0YS1zZWNyZXQ=" })
      expect(queryClient.getQueryData(["namespaces", "beta"])).toEqual(["kube-system"])
    } finally {
      vi.useRealTimers()
    }
  })

  // The other end-of-session path reaches the same eviction, so Sign out and a
  // 401 cannot drift from the TTL guard again.
  it("clearSession() evicts only that context's cached responses", () => {
    const auth = useAuthStore()
    const queryClient = withQueryCache()
    auth.setSession("alpha", SENTINEL, null, false)
    auth.setSession("beta", SENTINEL_B, null, false)
    queryClient.setQueryData(["namespaces", "alpha"], ["default"])
    queryClient.setQueryData(["namespaces", "beta"], ["kube-system"])

    auth.clearSession("alpha")

    expect(queryClient.getQueryData(["namespaces", "alpha"])).toBeUndefined()
    expect(queryClient.getQueryData(["namespaces", "beta"])).toEqual(["kube-system"])
  })

  // Regression: isAuthenticated used to check only for a token, so an expired
  // session read as signed in until something got round to pruning it —
  // switching to a stale cluster flashed past the login guard.
  it("isAuthenticated is false once the active session passes its TTL", () => {
    const auth = useAuthStore()
    auth.setSession("alpha", SENTINEL, null, false)
    expect(auth.isAuthenticated).toBe(true)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000)
      auth.setSession("beta", SENTINEL_B, null, false)
      // Switching to the expired cluster: not authenticated, and the stale
      // token is gone from storage rather than merely hidden.
      auth.setActiveContext("alpha")
      expect(auth.isAuthenticated).toBe(false)
      expect(auth.token).toBeNull()
      expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY) ?? "").not.toContain(SENTINEL)
    } finally {
      vi.useRealTimers()
    }
  })

  // What a late 401 from a cluster the user already switched away from does.
  it("clearSession(context) ends a non-active session, leaving the active one", () => {
    const auth = useAuthStore()
    auth.setSession("alpha", SENTINEL, null, false)
    auth.setSession("beta", SENTINEL_B, null, false) // beta active

    auth.clearSession("alpha")

    expect(auth.activeContext).toBe("beta")
    expect(auth.token).toBe(SENTINEL_B)
    expect(auth.isAuthenticated).toBe(true)
    expect(auth.hasSession("alpha")).toBe(false)
    expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY) ?? "").not.toContain(SENTINEL)
  })

  // Regression: kubeconfig context names are arbitrary printable ASCII, so a
  // name like "__proto__" must behave as a plain key (no prototype pollution,
  // no session silently lost on restore) and "constructor" must not resolve an
  // inherited Object.prototype member as a session.
  it("handles __proto__/constructor context names as plain keys", () => {
    const auth = useAuthStore()
    auth.setSession("__proto__", SENTINEL, { username: "jane" }, false)
    expect(auth.token).toBe(SENTINEL)

    // Survives a reload round-trip through sessionStorage.
    setActivePinia(createPinia())
    const restored = useAuthStore()
    expect(restored.activeContext).toBe("__proto__")
    expect(restored.token).toBe(SENTINEL)

    restored.setActiveContext("constructor")
    expect(restored.token).toBeNull()
    expect(restored.isAuthenticated).toBe(false)
  })

  it("serializes only allowlisted preference fields", () => {
    const prefs = usePreferencesStore()
    ;(prefs.prefs as unknown as Record<string, unknown>).token = SENTINEL
    ;(prefs.prefs as unknown as Record<string, unknown>).secretData = { a: SENTINEL }

    const serialized = serializePreferences(prefs.prefs)
    expect(serialized).not.toContain(SENTINEL)
    expect(serialized).toContain("pinnedResources")
  })

  it("persists preferences under the expected key after refresh-like reload", async () => {
    const prefs = usePreferencesStore()
    prefs.prefs.theme = "dark"
    await nextTick()
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string).theme).toBe("dark")
  })
})
