// document.title tracks the active cluster: it follows a context switch, and
// an operator-set cluster name wins over whatever context is active.

import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Ref } from "vue"
import { defineComponent, h, nextTick, ref } from "vue"

import type { ContextsResponse } from "@/api/types"

// The mocked useQuery hands out this ref; tests drive its value to simulate
// the contexts response arriving. Built per test, not inside vi.hoisted —
// that runs before the vue import.
const state = vi.hoisted(() => ({
  data: undefined as Ref<ContextsResponse | undefined> | undefined,
}))
vi.mock("@tanstack/vue-query", () => ({
  useQuery: () => ({ data: state.data }),
}))

import { usePageTitle } from "@/composables/usePageTitle"
import { useAuthStore } from "@/stores/auth"

function mountTitle(): void {
  const Host = defineComponent({
    setup() {
      usePageTitle()
      return () => h("div")
    },
  })
  mount(Host)
}

describe("usePageTitle", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    state.data = ref<ContextsResponse | undefined>(undefined)
    document.title = ""
  })

  it("names the active context and follows a switch", async () => {
    const auth = useAuthStore()
    auth.setActiveContext("prod-eks")
    mountTitle()
    await nextTick()
    expect(document.title).toBe("prod-eks · kube-console")

    auth.setActiveContext("staging")
    await nextTick()
    expect(document.title).toBe("staging · kube-console")
  })

  it("stays bare on a synthesized in-cluster context", async () => {
    useAuthStore().setActiveContext("default")
    mountTitle()
    await nextTick()
    expect(document.title).toBe("kube-console")
  })

  it("uses the configured cluster name once contexts load", async () => {
    const auth = useAuthStore()
    auth.setActiveContext("default")
    mountTitle()
    await nextTick()
    expect(document.title).toBe("kube-console")

    state.data!.value = { contexts: [{ name: "default" }], default: "default", clusterName: "Prod EU" }
    await nextTick()
    expect(document.title).toBe("Prod EU · kube-console")
  })
})
