import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query"
import { createPinia } from "pinia"
import { createApp } from "vue"

import { setCredentialProvider, setUnauthorizedHandler, setUnknownContextHandler } from "@/api/http"
import type { ContextsResponse } from "@/api/types"
import { endSession } from "@/auth/endSession"
import { KubernetesTokenProvider } from "@/auth/KubernetesTokenProvider"
import { createAppRouter } from "@/router"
import { useAuthStore } from "@/stores/auth"

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
setUnauthorizedHandler((context) => {
  // 401: end only the session of the context the request was routed to (a
  // valid session for another cluster must survive). The redirect is global,
  // so it only fires when that context is still the one on screen — a 401 from
  // a request that outlived a cluster switch must not throw the user out of the
  // cluster they just switched to.
  const auth = useAuthStore()
  endSession(queryClient, context)
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

app.mount("#app")
