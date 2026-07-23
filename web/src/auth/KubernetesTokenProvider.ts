// KubernetesTokenProvider: the manual-token CredentialProvider backed by the
// in-memory auth store.

import { useAuthStore } from "@/stores/auth"

import type { CredentialProvider } from "./CredentialProvider"

export class KubernetesTokenProvider implements CredentialProvider {
  async getBearerToken(): Promise<string | null> {
    const store = useAuthStore()
    // TTL guard: drop every session past its lifetime — not just the active
    // one — so an expired token stops sitting in sessionStorage. Still-valid
    // sessions for other clusters survive.
    store.pruneExpiredSessions()
    return store.token
  }

  getContext(): string | null {
    const store = useAuthStore()
    return store.activeContext !== "" ? store.activeContext : null
  }

  async logout(context?: string): Promise<void> {
    const store = useAuthStore()
    // The caller passes the context the failed request was routed to, which is
    // not necessarily the active one any more: a 401 arriving after a cluster
    // switch must end the session it belongs to, never the newly selected one.
    store.clearSession(context ?? store.activeContext)
  }
}
