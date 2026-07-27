// Contexts query: the kubeconfig context names + default, fetched once
// authenticated. The backend verifies the bearer against the apiserver before
// naming any cluster (names describe the estate), so this 401s on an expired
// token like any other call. Drives the cluster switcher and keeps the active
// context reconciled with reality.

import { useQuery } from "@tanstack/vue-query"
import { computed, watch } from "vue"
import { useRouter, type Router } from "vue-router"

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

/**
 * Recover from a context the backend no longer knows: the reconcile below sees
 * it disappear from the list, and `api/http.ts` sees the `400` any request to it
 * gets. Both reach this one function, because they are one decision and drifted
 * apart while they were two — the 400 path used to reset the active context to
 * `""` and never route anywhere, leaving the app on a protected view with every
 * context-scoped query gated off.
 *
 * `knownDefault` is the default from a context list, when one is known. Returns
 * whether the caller should refetch that list: false when the fallback is the
 * rejected name itself, since re-issuing the request that just failed would
 * re-enter this function — a loop with no backoff.
 */
export function recoverFromUnknownContext(
  router: Router,
  rejected: string,
  knownDefault: string | undefined,
): boolean {
  const auth = useAuthStore()

  // Nothing in the SPA can spend this token any more: every request carries the
  // context name the backend rejects. Drop it through the one end-of-session
  // path, which also evicts what the session fetched — a Pod Env tab's
  // ConfigMap/Secret payloads must not outlive the cluster they came from. It
  // may well still be a valid apiserver credential, but keeping it would also
  // keep the login page offering a dead cluster badged "signed in", and picking
  // it walks straight back into requests that all 400.
  auth.clearSession(rejected)

  // Never "": sessions are keyed by resolved context names, so an empty active
  // context resolves to no session and orphans every still-valid one. With no
  // list to fall back on the name is kept — on a reload there is no cached list
  // precisely because fetching it carries the rejected name too, so it failed
  // exactly as this request did — and the login page's picker offers whatever
  // is still signed in.
  const fallback = knownDefault !== undefined && knownDefault !== "" ? knownDefault : auth.activeContext
  auth.setActiveContext(fallback)

  if (!auth.isAuthenticated) {
    // Straight to login rather than leaving a protected view to fire tokenless
    // requests until one 401s.
    void router.push({ name: "login" })
    return false
  }
  // A detail page is collapsed to its list, exactly as ClusterSelector does on a
  // deliberate switch: the object on screen belongs to the cluster that just
  // disappeared, and every context-scoped query key is rebuilt under the
  // fallback — but ResourceDetailPage has no context watch and useResourceObject
  // only refetches on a route-param change, so the header, the YAML tab and the
  // action buttons would keep describing the removed cluster's object while
  // Delete and Apply are already stamped X-Kube-Context: <fallback>, hitting the
  // same-named object in a different cluster.
  const route = router.currentRoute.value
  if (route.name === "resource-detail") {
    void router.push({
      name: "resource-list",
      params: {
        group: route.params.group,
        version: route.params.version,
        resource: route.params.resource,
      },
    })
  }
  return fallback !== rejected
}

export function useContexts() {
  const auth = useAuthStore()
  const router = useRouter()
  const query = useContextsQuery()

  const contexts = computed<ContextInfo[]>(() => query.data.value?.contexts ?? [])

  // Reconcile: an active context that is no longer in the kubeconfig (removed
  // upstream) falls back to the default so the UI never points at a dead
  // cluster. The list in hand is fresh, so the refetch it reports is ignored.
  watch(
    () => query.data.value,
    (data) => {
      if (data === undefined) return
      // Nothing selected yet: adopt the backend's default. In token mode a
      // login resolves the name (VerifyResponse.Context) and this never fires —
      // the query is gated on a session for the active context, so an empty one
      // gates it off. Under --use-kubeconfig-credentials there is no login at
      // all, so the active context stayed "" for the whole run: every request
      // was in fact served by this very default (an empty X-Kube-Context
      // resolves to it), while the switcher sat on its "Select cluster"
      // placeholder and the page title had no cluster to name — the UI could
      // not say which cluster the data on screen came from.
      if (auth.activeContext === "") {
        if (data.default !== "") auth.setActiveContext(data.default)
        return
      }
      const names = data.contexts.map((c) => c.name)
      if (!names.includes(auth.activeContext)) {
        recoverFromUnknownContext(router, auth.activeContext, data.default)
      }
    },
  )

  return { ...query, contexts }
}
