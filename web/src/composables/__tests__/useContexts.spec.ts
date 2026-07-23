// Reconcile invariants: an active context that vanished from the kubeconfig
// falls back to the default, and lands on login when the default has no
// session (never leaves a protected view firing tokenless requests).

import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h, nextTick, ref } from "vue"

import type { ContextsResponse } from "@/api/types"

// One shared ref the mocked useQuery hands out; tests drive its value to
// simulate the query resolving (undefined → data), which fires the watch.
const state = vi.hoisted(() => ({
  data: undefined as { value: unknown } | undefined,
}))
vi.mock("@tanstack/vue-query", () => ({
  useQuery: () => ({ data: state.data }),
}))

const push = vi.fn()
vi.mock("vue-router", () => ({ useRouter: () => ({ push }) }))

import { useContexts } from "@/composables/useContexts"
import { useAuthStore } from "@/stores/auth"

// The composable's watch needs a component scope to run in.
function mountContexts(): ReturnType<typeof useContexts> {
  let result!: ReturnType<typeof useContexts>
  const Host = defineComponent({
    setup() {
      result = useContexts()
      return () => h("div")
    },
  })
  mount(Host)
  return result
}

async function resolveContexts(response: ContextsResponse): Promise<void> {
  ;(state.data as { value: unknown }).value = response
  await nextTick()
}

describe("useContexts", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    setActivePinia(createPinia())
    push.mockReset()
    state.data = ref<ContextsResponse | undefined>(undefined)
  })

  it("exposes the context list once loaded", async () => {
    const { contexts } = mountContexts()
    expect(contexts.value).toEqual([])
    await resolveContexts({ contexts: [{ name: "alpha" }, { name: "beta" }], default: "alpha" })
    expect(contexts.value.map((c) => c.name)).toEqual(["alpha", "beta"])
  })

  it("keeps an active context that still exists", async () => {
    const auth = useAuthStore()
    auth.setSession("beta", "tok-b", null, false)
    mountContexts()
    await resolveContexts({ contexts: [{ name: "alpha" }, { name: "beta" }], default: "alpha" })
    expect(auth.activeContext).toBe("beta")
    expect(push).not.toHaveBeenCalled()
  })

  it("falls back to the default when the active context vanished", async () => {
    const auth = useAuthStore()
    auth.setSession("alpha", "tok-a", null, false)
    auth.setSession("ghost", "tok-g", null, false) // active, then removed upstream
    mountContexts()
    await resolveContexts({ contexts: [{ name: "alpha" }], default: "alpha" })
    expect(auth.activeContext).toBe("alpha")
    // The default still has a valid session: stay on the current view.
    expect(push).not.toHaveBeenCalled()
  })

  // Regression: landing on a sessionless default must go to login immediately
  // instead of leaving a protected view to fire tokenless requests until a 401.
  it("routes to login when the fallback default has no session", async () => {
    const auth = useAuthStore()
    auth.setSession("ghost", "tok-g", null, false) // only signed into ghost
    mountContexts()
    await resolveContexts({ contexts: [{ name: "alpha" }], default: "alpha" })
    expect(auth.activeContext).toBe("alpha")
    expect(push).toHaveBeenCalledWith({ name: "login" })
  })
})
