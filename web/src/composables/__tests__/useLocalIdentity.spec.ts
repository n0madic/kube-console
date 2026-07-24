// Identity for the local kubeconfig mode. The kubeconfig may authenticate as a
// different user per context, so what the store holds must never outlive the
// context it was resolved for.

import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query"
import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h, nextTick } from "vue"

import type { VerifyResponse } from "@/api/types"
import { useLocalIdentity } from "@/composables/useLocalIdentity"
import { useAuthStore } from "@/stores/auth"

const fetchIdentity = vi.fn<() => Promise<VerifyResponse>>()
vi.mock("@/api/ui", () => ({ fetchIdentity: () => fetchIdentity() }))

function mountHost() {
  const Host = defineComponent({
    setup() {
      useLocalIdentity()
      return () => h("div")
    },
  })
  return mount(Host, {
    global: {
      plugins: [[VueQueryPlugin, { queryClient: new QueryClient() }]],
    },
  })
}

/** Wait for the query to settle into the store. */
async function settle(): Promise<void> {
  await vi.waitFor(() => expect(fetchIdentity).toHaveBeenCalled())
  for (let i = 0; i < 5; i++) await nextTick()
}

describe("useLocalIdentity", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    fetchIdentity.mockReset()
  })

  it("does not fetch outside the local kubeconfig mode", async () => {
    mountHost()
    await nextTick()
    expect(fetchIdentity).not.toHaveBeenCalled()
  })

  it("stores the identity the backend's credentials resolve to", async () => {
    const auth = useAuthStore()
    auth.setLocalAuth(true)
    fetchIdentity.mockResolvedValue({ authenticated: true, identity: { username: "dev@staging" } })

    mountHost()
    await settle()

    expect(auth.identity).toEqual({ username: "dev@staging" })
    expect(auth.identityUnavailable).toBe(false)
  })

  // Regression: on a context switch the query key changes and data goes
  // undefined. Keeping the previous value left TopBar naming the wrong user
  // while requests already went to the new cluster.
  it("clears the identity while a switched-to context is still resolving", async () => {
    const auth = useAuthStore()
    auth.setLocalAuth(true)
    auth.setActiveContext("alpha")
    fetchIdentity.mockResolvedValue({ authenticated: true, identity: { username: "dev@staging" } })

    mountHost()
    await settle()
    expect(auth.identity).toEqual({ username: "dev@staging" })

    // Switch to a cluster whose identity has not arrived yet.
    let resolveSecond: (v: VerifyResponse) => void = () => {}
    fetchIdentity.mockReturnValue(
      new Promise<VerifyResponse>((resolve) => {
        resolveSecond = resolve
      }),
    )
    auth.setActiveContext("beta")
    for (let i = 0; i < 5; i++) await nextTick()

    expect(auth.identity).toBeNull()

    resolveSecond({ authenticated: true, identity: { username: "admin@prod" } })
    await vi.waitFor(() => expect(auth.identity).toEqual({ username: "admin@prod" }))
  })

  it("carries identityUnavailable through", async () => {
    const auth = useAuthStore()
    auth.setLocalAuth(true)
    fetchIdentity.mockResolvedValue({ authenticated: true, identityUnavailable: true })

    mountHost()
    await settle()

    expect(auth.identity).toBeNull()
    expect(auth.identityUnavailable).toBe(true)
  })
})
