// Auth store: bearer tokens live in this tab only, one per kubeconfig context.
// They are mirrored into sessionStorage (tab-scoped, never shared across tabs,
// gone when the tab closes) so a page reload keeps the sessions — each bounded
// by an absolute TTL. Tokens never touch localStorage, IndexedDB, cookies or
// URLs. The active context selects which session the getters resolve.

import { defineStore } from "pinia"
import { computed, ref } from "vue"

import type { Identity } from "@/api/types"
import { clearMetricsCacheContext } from "@/utils/metricsCache"

export const SESSION_STORAGE_KEY = "kube-console.session.v1"
/** Absolute session lifetime after login; afterwards a new login is forced. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000

/**
 * Evicts one context's cached server responses. Injected from main.ts, where
 * the QueryClient is built — a store must not import the app instance, the same
 * reason api/http.ts takes its handlers by injection.
 *
 * It lives here, beside clearMetricsCacheContext, so that *every* way a session
 * ends evicts the same three things (token, chart buffers, query cache). Wiring
 * it into the callers instead is what let the TTL path drift: an expired
 * session dropped its token while the responses fetched with it — including
 * Secret payloads on the Pod Env tab — stayed in the cache until a sign-out.
 */
type ContextPruner = (context: string) => void
let pruneContextQueries: ContextPruner | null = null

export function setQueryPruner(prune: ContextPruner | null): void {
  pruneContextQueries = prune
}

interface StoredSession {
  token: string
  identity: Identity | null
  identityUnavailable: boolean
  expiresAt: number
}

interface StoredSessions {
  activeContext: string
  sessions: Record<string, StoredSession>
}

/** Null-prototype map so kubeconfig context names ("__proto__", "constructor",
 * ...) are always plain own keys with no inherited lookups. */
function emptySessions(): Record<string, StoredSession> {
  return Object.create(null) as Record<string, StoredSession>
}

/** Own-key lookup: never resolve a session through the prototype chain. */
function sessionFor(
  sessions: Record<string, StoredSession>,
  context: string,
): StoredSession | null {
  return Object.hasOwn(sessions, context) ? (sessions[context] ?? null) : null
}

function parseIdentity(value: unknown): Identity | null {
  if (typeof value !== "object" || value === null) return null
  const id = value as Partial<Identity>
  if (typeof id.username !== "string") return null
  return {
    username: id.username,
    ...(typeof id.uid === "string" ? { uid: id.uid } : {}),
    ...(Array.isArray(id.groups) && id.groups.every((g) => typeof g === "string")
      ? { groups: id.groups }
      : {}),
  }
}

/** True once a stored session has passed its absolute lifetime. Checked lazily
 * (never as a reactive clock), so every read path that must not accept a stale
 * token goes through it. */
function isSessionExpired(session: StoredSession): boolean {
  return session.expiresAt > 0 && session.expiresAt <= Date.now()
}

/** Validate a single stored session; returns null for a missing/expired/tampered entry. */
function parseSession(value: unknown): StoredSession | null {
  if (typeof value !== "object" || value === null) return null
  const s = value as Partial<StoredSession>
  if (
    typeof s.token !== "string" ||
    s.token === "" ||
    typeof s.expiresAt !== "number" ||
    s.expiresAt <= Date.now()
  ) {
    return null
  }
  return {
    token: s.token,
    identity: parseIdentity(s.identity),
    identityUnavailable: s.identityUnavailable === true,
    expiresAt: s.expiresAt,
  }
}

/** Restore result: `dirty` means storage held entries that were dropped
 * (expired/tampered/corrupt) and must be scrubbed by rewriting immediately —
 * an expired bearer token must not linger in sessionStorage. */
function readStoredSessions(): StoredSessions & { dirty: boolean } {
  const empty = { activeContext: "", sessions: emptySessions(), dirty: false }
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (raw === null) return empty
    const parsed = JSON.parse(raw) as Partial<StoredSessions>
    const activeContext = typeof parsed.activeContext === "string" ? parsed.activeContext : ""
    // Null prototype: context names come from the kubeconfig, so a name like
    // "__proto__" must become a plain own key, never touch the prototype.
    const sessions = emptySessions()
    let dirty = false
    if (typeof parsed.sessions === "object" && parsed.sessions !== null) {
      for (const [name, value] of Object.entries(parsed.sessions)) {
        const session = parseSession(value)
        if (session !== null) sessions[name] = session
        else dirty = true
      }
    }
    return { activeContext, sessions, dirty }
  } catch {
    return { ...empty, dirty: true }
  }
}

function writeStoredSessions(state: StoredSessions): void {
  try {
    if (state.activeContext === "" && Object.keys(state.sessions).length === 0) {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY)
    } else {
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(state))
    }
  } catch {
    // Storage unavailable: the sessions simply will not survive a reload.
  }
}

export const useAuthStore = defineStore("auth", () => {
  const restored = readStoredSessions()

  const activeContext = ref(restored.activeContext)
  const sessions = ref<Record<string, StoredSession>>(restored.sessions)

  function persist(): void {
    writeStoredSessions({ activeContext: activeContext.value, sessions: sessions.value })
  }

  // Scrub storage right away when the restore dropped entries, so an expired
  // token string never lingers in sessionStorage past its TTL. This is the
  // startup half of pruneExpiredSessions (parseSession rejects expired
  // entries); pruneExpiredSessions covers sessions that expire while the tab
  // stays open.
  if (restored.dirty) persist()

  const active = computed<StoredSession | null>(() => sessionFor(sessions.value, activeContext.value))

  const token = computed<string | null>(() => active.value?.token ?? null)
  const identity = computed<Identity | null>(() => active.value?.identity ?? null)
  const identityUnavailable = computed(() => active.value?.identityUnavailable ?? false)
  /** A token alone is not authentication: an expired one must never read as
   * signed in, or switching to a stale context flashes past the login guard. */
  const isAuthenticated = computed(() => {
    const session = active.value
    return session !== null && session.token !== "" && !isSessionExpired(session)
  })

  /**
   * True when this tab holds a usable token for the given context — what the
   * cluster switcher marks as already signed in. Expiry is checked lazily
   * (never as a reactive clock), so this is a read-only view: dropping what has
   * expired is pruneExpiredSessions' job, and it must not happen inside the
   * computeds that call this.
   */
  function hasSession(context: string): boolean {
    const session = sessionFor(sessions.value, context)
    return session !== null && session.token !== "" && !isSessionExpired(session)
  }

  /** Every context this tab still holds a usable token for. Lets the login page
   * offer a way back when a switch landed on a cluster the user cannot (or does
   * not want to) sign into — otherwise the only way out is pasting a token.
   * A function, not a computed: expiry is checked lazily like hasSession, and a
   * computed would cache a result that only Date.now() has invalidated. */
  function signedInContexts(): string[] {
    return Object.keys(sessions.value)
      .filter((name) => hasSession(name))
      .sort()
  }

  /** Store (and activate) the session for a context after a successful verify. */
  function setSession(
    context: string,
    newToken: string,
    newIdentity: Identity | null,
    unavailable: boolean,
  ): void {
    sessions.value = Object.assign(emptySessions(), sessions.value, {
      [context]: {
        token: newToken,
        identity: newIdentity,
        identityUnavailable: unavailable,
        expiresAt: Date.now() + SESSION_TTL_MS,
      },
    })
    activeContext.value = context
    persist()
  }

  /** Point at another context. Its session (if any) becomes the resolved one.
   * Expired sessions are dropped first, so the switch resolves against what is
   * actually usable instead of briefly reading as signed in. */
  function setActiveContext(name: string): void {
    pruneExpiredSessions()
    activeContext.value = name
    persist()
  }

  /** Drop one context's session, keeping every other cluster signed in. The
   * single end-of-session path: explicit Sign out, the 401 handler and the TTL
   * guard all reach it, so an ended session for cluster B never wipes a
   * still-valid one for cluster A. The active context NAME is deliberately kept
   * — signing out is not a switch, and the login page names the cluster. */
  function clearSession(context: string): void {
    if (Object.hasOwn(sessions.value, context)) {
      const next = Object.assign(emptySessions(), sessions.value)
      delete next[context]
      sessions.value = next
      persist()
    }
    evictContextCaches(context)
  }

  /** Everything fetched with a session dies with it. Scoped to the one cluster:
   * other clusters' still-valid sessions keep their charts and cached lists. */
  function evictContextCaches(context: string): void {
    clearMetricsCacheContext(context)
    pruneContextQueries?.(context)
  }

  /** clearSession for whichever context is active right now. */
  function clearActiveSession(): void {
    clearSession(activeContext.value)
  }

  /**
   * Drop every session past its TTL and rewrite storage. Hiding an expired
   * entry behind hasSession is not enough: the token string itself stays in
   * sessionStorage, readable by any same-origin script, until something
   * rewrites the record — and the responses it fetched stay in the query cache,
   * which is where Secret and ConfigMap payloads live once the Pod Env tab has
   * read them. Called wherever a session is about to be used or chosen (token
   * fetch, context switch, route guard); a restore does the same job at
   * startup. Returns the contexts it dropped.
   */
  function pruneExpiredSessions(): string[] {
    const expired = Object.keys(sessions.value).filter((name) => {
      const session = sessionFor(sessions.value, name)
      return session !== null && isSessionExpired(session)
    })
    if (expired.length === 0) return []
    const next = Object.assign(emptySessions(), sessions.value)
    for (const name of expired) delete next[name]
    sessions.value = next
    persist()
    // Exactly what clearSession does, for each expired cluster.
    for (const name of expired) evictContextCaches(name)
    return expired
  }

  return {
    activeContext,
    token,
    identity,
    identityUnavailable,
    isAuthenticated,
    hasSession,
    signedInContexts,
    setSession,
    setActiveContext,
    clearSession,
    clearActiveSession,
    pruneExpiredSessions,
  }
})
