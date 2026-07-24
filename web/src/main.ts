import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query"
import { createPinia } from "pinia"
import { createApp } from "vue"

import { setCredentialProvider, setUnauthorizedHandler, setUnknownContextHandler } from "@/api/http"
import type { ContextsResponse } from "@/api/types"
import { fetchAuthMode } from "@/api/ui"
import { KubernetesTokenProvider } from "@/auth/KubernetesTokenProvider"
import { createAppRouter } from "@/router"
import { setQueryPruner, useAuthStore } from "@/stores/auth"

import App from "./App.vue"
import "./style.css"

const app = createApp(App)
const pinia = createPinia()
const router = createAppRouter()
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
})

app.use(pinia)
app.use(router)
app.use(VueQueryPlugin, { queryClient })

setCredentialProvider(new KubernetesTokenProvider())
// Whatever ends a session — Sign out, a 401, or the TTL guard — drops that
// context's cached responses with its token. Query keys are context-scoped, so
// pruning by name leaves other clusters' caches intact for an instant
// switch-back; never queryClient.clear(). Registered before mount, so no
// session can end without it.
setQueryPruner((context) => {
  queryClient.removeQueries({ predicate: (q) => q.queryKey.includes(context) })
})
setUnauthorizedHandler((context) => {
  // 401: end only the session of the context the request was routed to (a
  // valid session for another cluster must survive). The redirect is global,
  // so it only fires when that context is still the one on screen — a 401 from
  // a request that outlived a cluster switch must not throw the user out of the
  // cluster they just switched to.
  const auth = useAuthStore()
  // In the local kubeconfig mode a 401 means the apiserver rejected the
  // *backend's* credentials. There is no session to end and no token to
  // re-enter, so /login would be a loop in front of a form with nothing to fill
  // in; let the error surface where it was raised instead.
  if (auth.localAuth) return
  auth.clearSession(context)
  if (context === auth.activeContext) void router.push({ name: "login" })
})
setUnknownContextHandler((context) => {
  // The context vanished upstream (kubeconfig changed): reset to the default
  // context NAME (sessions are keyed by real names, so "" would orphan a
  // still-valid default session) and let the context list refetch. Ignored when
  // the rejected context is no longer active: the user has already moved on,
  // and resetting would undo their switch.
  const auth = useAuthStore()
  if (context !== auth.activeContext) return
  const cached = queryClient.getQueryData<ContextsResponse>(["contexts"])
  auth.setActiveContext(cached?.default ?? "")
  void queryClient.invalidateQueries({ queryKey: ["contexts"] })
})

/** Bounds the pre-mount probe below. A backend that accepts the connection and
 * then stalls must not be able to hold the page blank forever. */
const AUTH_MODE_TIMEOUT_MS = 5000

// The auth mode decides whether there is a login page at all, and the route
// guard runs on the very first navigation — so it has to be known before mount.
// Any failure, including the timeout, resolves to token mode: fail closed onto
// the login page rather than waving a broken backend through as locally
// authenticated, and mount regardless so the error is visible in the app instead
// of as an empty document.
async function bootstrap(): Promise<void> {
  try {
    const { mode } = await fetchAuthMode(AbortSignal.timeout(AUTH_MODE_TIMEOUT_MS))
    if (mode === "kubeconfig") useAuthStore().setLocalAuth(true)
  } catch {
    // Unreachable, stalled or unrecognized backend: stay in token mode.
  }
  app.mount("#app")
}

void bootstrap()
