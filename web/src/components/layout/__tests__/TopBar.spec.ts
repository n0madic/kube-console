// Sign out ends the CURRENT cluster's session only: other contexts keep their
// tokens and cached data, and the context name survives so the login page can
// name the cluster (signing out is not a context switch).

import { QueryClient } from "@tanstack/vue-query"
import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"

const push = vi.fn()
vi.mock("vue-router", () => ({ useRouter: () => ({ push }) }))

let queryClient: QueryClient

import TopBar from "@/components/layout/TopBar.vue"
import { setQueryPruner, useAuthStore } from "@/stores/auth"
import { useUiStore } from "@/stores/ui"

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

// The header now opens with the sidebar toggle, so buttons are found by what
// they say, never by position.
function signOutButton(wrapper: ReturnType<typeof mountBar>) {
  return wrapper.findAll("button").find((b) => b.text().includes("Sign out"))
}

describe("TopBar sign out", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    setActivePinia(createPinia())
    push.mockReset()
    queryClient = new QueryClient()
    // The eviction hook main.ts installs: Sign out goes through the store's
    // clearActiveSession, which prunes the cache through this.
    setQueryPruner((context) => {
      queryClient.removeQueries({ predicate: (q) => q.queryKey.includes(context) })
    })
  })

  it("ends only the active context's session and keeps its name", async () => {
    const auth = useAuthStore()
    auth.setSession("beta", TOKEN_B, null, false)
    auth.setSession("alpha", TOKEN_A, null, false) // alpha is active

    const wrapper = mountBar()
    await signOutButton(wrapper)!.trigger("click")

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
    await signOutButton(wrapper)!.trigger("click")

    expect(queryClient.getQueryData(["namespaces", "alpha"])).toBeUndefined()
    expect(queryClient.getQueryData(["namespaces", "beta"])).toEqual(["kube-system"])
  })
  // In the local kubeconfig mode the credentials belong to the backend: there
  // is no session to end, and the login page it would push to has no form.
  it("hides Sign out in the local kubeconfig mode", () => {
    const auth = useAuthStore()
    auth.setLocalAuth(true)

    const wrapper = mountBar()

    expect(signOutButton(wrapper)).toBeUndefined()
    expect(wrapper.text()).not.toContain("Sign out")
  })
})

// The toggle is in the TopBar only while the sidebar is hidden; while it is
// open the same control sits in the sidebar's own header.
describe("TopBar sidebar toggle", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    setActivePinia(createPinia())
  })

  function toggleOf(wrapper: ReturnType<typeof mountBar>) {
    return wrapper.findAll("button").find((b) => b.attributes("aria-controls") === "app-sidebar")
  }

  it("appears only while the sidebar is hidden, and shows it again", async () => {
    const ui = useUiStore()
    const wrapper = mountBar()
    // The sidebar starts open, so its own header carries the toggle.
    expect(ui.sidebarOpen).toBe(true)
    expect(toggleOf(wrapper)).toBeUndefined()

    ui.toggleSidebar()
    await nextTick()

    const toggle = toggleOf(wrapper)
    expect(toggle).toBeDefined()
    expect(toggle!.attributes("aria-expanded")).toBe("false")
    expect(toggle!.attributes("aria-label")).toBe("Show sidebar")

    await toggle!.trigger("click")
    await nextTick()

    expect(ui.sidebarOpen).toBe(true)
    expect(toggleOf(wrapper)).toBeUndefined()
  })
})
