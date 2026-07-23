// Sign out ends the CURRENT cluster's session only: other contexts keep their
// tokens and cached data, and the context name survives so the login page can
// name the cluster (signing out is not a context switch).

import { QueryClient } from "@tanstack/vue-query"
import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"

const push = vi.fn()
vi.mock("vue-router", () => ({ useRouter: () => ({ push }) }))

let queryClient: QueryClient
vi.mock("@tanstack/vue-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/vue-query")>("@tanstack/vue-query")
  return { ...actual, useQueryClient: () => queryClient }
})

import TopBar from "@/components/layout/TopBar.vue"
import { useAuthStore } from "@/stores/auth"

const TOKEN_A = "SENTINEL-token-alpha"
const TOKEN_B = "SENTINEL-token-beta"

function mountBar() {
  return mount(TopBar, {
    global: {
      stubs: {
        NamespaceSelector: true,
        ThemeToggle: true,
        BaseButton: { template: "<button><slot /></button>" },
      },
    },
  })
}

describe("TopBar sign out", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    setActivePinia(createPinia())
    push.mockReset()
    queryClient = new QueryClient()
  })

  it("ends only the active context's session and keeps its name", async () => {
    const auth = useAuthStore()
    auth.setSession("beta", TOKEN_B, null, false)
    auth.setSession("alpha", TOKEN_A, null, false) // alpha is active

    const wrapper = mountBar()
    await wrapper.get("button").trigger("click")

    expect(auth.isAuthenticated).toBe(false)
    expect(auth.hasSession("alpha")).toBe(false)
    // The other cluster stays signed in...
    expect(auth.hasSession("beta")).toBe(true)
    // ...and the login page still knows which cluster we left.
    expect(auth.activeContext).toBe("alpha")
    expect(push).toHaveBeenCalledWith({ name: "login" })
    expect(window.sessionStorage.getItem("kube-console.session.v1") ?? "").not.toContain(TOKEN_A)
  })

  it("prunes only the ended context's query cache", async () => {
    const auth = useAuthStore()
    auth.setSession("beta", TOKEN_B, null, false)
    auth.setSession("alpha", TOKEN_A, null, false)
    queryClient.setQueryData(["namespaces", "alpha"], ["default"])
    queryClient.setQueryData(["namespaces", "beta"], ["kube-system"])

    const wrapper = mountBar()
    await wrapper.get("button").trigger("click")

    expect(queryClient.getQueryData(["namespaces", "alpha"])).toBeUndefined()
    expect(queryClient.getQueryData(["namespaces", "beta"])).toEqual(["kube-system"])
  })
})
