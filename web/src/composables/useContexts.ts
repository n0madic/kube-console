// Contexts query: the kubeconfig context names + default, fetched once
// authenticated. The backend verifies the bearer against the apiserver before
// naming any cluster (names describe the estate), so this 401s on an expired
// token like any other call. Drives the cluster switcher and keeps the active
// context reconciled with reality.

import { useQuery } from "@tanstack/vue-query"
import { computed, watch } from "vue"
import { useRouter } from "vue-router"

import { fetchContexts } from "@/api/ui"
import type { ContextInfo } from "@/api/types"
import { useAuthStore } from "@/stores/auth"

/**
 * The bare query, without the reconcile side effects below. Callers that only
 * read the response — the page title — take this one, so the fallback-and-route
 * watch keeps running exactly once, in the switcher that owns it.
 */
export function useContextsQuery() {
  const auth = useAuthStore()
  return useQuery({
    queryKey: ["contexts"],
    queryFn: fetchContexts,
    enabled: computed(() => auth.isAuthenticated),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })
}

export function useContexts() {
  const auth = useAuthStore()
  const router = useRouter()
  const query = useContextsQuery()

  const contexts = computed<ContextInfo[]>(() => query.data.value?.contexts ?? [])

  // Reconcile: an active context that is no longer in the kubeconfig (removed
  // upstream) falls back to the default so the UI never points at a dead
  // cluster. If the default has no session yet, go to login right away instead
  // of leaving a protected view to fire tokenless requests until one 401s.
  watch(
    () => query.data.value,
    (data) => {
      if (data === undefined) return
      const names = data.contexts.map((c) => c.name)
      if (auth.activeContext !== "" && !names.includes(auth.activeContext)) {
        auth.setActiveContext(data.default)
        if (!auth.isAuthenticated) void router.push({ name: "login" })
      }
    },
  )

  return { ...query, contexts }
}
