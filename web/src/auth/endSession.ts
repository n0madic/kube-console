// Ending the session of ONE cluster context — the explicit Sign out and the
// global 401 handler do exactly the same thing, so they share this.

import type { QueryClient } from "@tanstack/vue-query"

import { useAuthStore } from "@/stores/auth"

/**
 * Drop one context's token and its cached data, leaving every other cluster
 * signed in with its own cache. The active context NAME is untouched: ending a
 * session is not a switch, so the login page still knows which cluster is being
 * signed back into.
 *
 * Takes the context explicitly because the 401 handler is often reached by a
 * response that outlived the cluster it was sent to.
 */
export function endSession(queryClient: QueryClient, context: string): void {
  const auth = useAuthStore()
  // Also evicts only this context's metric series (see stores/auth).
  auth.clearSession(context)
  // Query keys are context-scoped, so pruning by the name leaves other
  // clusters' cached lists intact for an instant switch-back.
  queryClient.removeQueries({ predicate: (q) => q.queryKey.includes(context) })
}

/** endSession for whichever context is active — the explicit Sign out.
 * Returns the ended context name. */
export function endActiveSession(queryClient: QueryClient): string {
  const ended = useAuthStore().activeContext
  endSession(queryClient, ended)
  return ended
}
