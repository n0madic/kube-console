import { enableAutoUnmount, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

import type { ContextInfo } from "@/api/types"

vi.mock("@/composables/useContexts", () => ({ useContexts: vi.fn() }))

const push = vi.fn()
// Minimal resolve stub: the component only reads .fullPath of a resolved
// resource-list location when building the login redirect.
const resolve = vi.fn((to: { params: Record<string, string> }) => ({
  fullPath: `/r/${to.params.group}/${to.params.version}/${to.params.resource}`,
}))
let mockRoute: { name: string; params: Record<string, string>; fullPath: string }
vi.mock("vue-router", () => ({
  useRouter: () => ({ push, resolve }),
  useRoute: () => mockRoute,
}))

import { useContexts } from "@/composables/useContexts"
import ClusterSelector from "@/components/layout/ClusterSelector.vue"
import { SESSION_STORAGE_KEY, SESSION_TTL_MS, useAuthStore } from "@/stores/auth"

const mockedContexts = vi.mocked(useContexts)

function mockContexts(names: string[]) {
  const contexts = ref<ContextInfo[]>(names.map((name) => ({ name })))
  mockedContexts.mockReturnValue({ contexts } as unknown as ReturnType<typeof useContexts>)
}

// The selector is a custom listbox: open it, then click the option by name.
async function pick(wrapper: ReturnType<typeof mount>, name: string) {
  await wrapper.find("button").trigger("click")
  const option = wrapper
    .findAll("[role='option']")
    .find((o) => o.get('[data-testid="ctx-name"]').text() === name)
  if (option === undefined) throw new Error(`option ${name} not rendered`)
  await option.trigger("click")
}

describe("ClusterSelector", () => {
  // A page left mounted keeps rendering against the previous test's pinia (and
  // the listbox's document listener), which leaks state into the next test.
  enableAutoUnmount(afterEach)

  beforeEach(() => {
    // The auth store restores sessions from sessionStorage on creation; clear it
    // so a previous test's contexts do not leak in.
    window.sessionStorage.clear()
    window.localStorage.clear()
    setActivePinia(createPinia())
    push.mockReset()
    mockedContexts.mockReset()
    mockRoute = {
      name: "resource-list",
      params: { group: "core", version: "v1", resource: "pods" },
      fullPath: "/r/core/v1/pods",
    }
  })

  it("hides the selector with a single context", () => {
    mockContexts(["alpha"])
    const wrapper = mount(ClusterSelector)
    expect(wrapper.find("button").exists()).toBe(false)
  })

  it("renders the selector with more than one context", async () => {
    mockContexts(["alpha", "beta"])
    const wrapper = mount(ClusterSelector)
    expect(wrapper.find("button").exists()).toBe(true)
    // The list is only rendered while open.
    expect(wrapper.findAll("[role='option']")).toHaveLength(0)
    await wrapper.find("button").trigger("click")
    expect(
      wrapper.findAll("[role='option']").map((o) => o.get('[data-testid="ctx-name"]').text()),
    ).toEqual(["alpha", "beta"])
  })

  // Same order as the login page's picker, which has to sort a union of
  // unordered sources.
  it("sorts the contexts by name", async () => {
    mockContexts(["staging", "dev", "prod"])
    const wrapper = mount(ClusterSelector)
    await wrapper.find("button").trigger("click")
    expect(
      wrapper.findAll("[role='option']").map((o) => o.get('[data-testid="ctx-name"]').text()),
    ).toEqual(["dev", "prod", "staging"])
  })

  it("marks the contexts this tab already holds a token for", async () => {
    mockContexts(["alpha", "beta"])
    const auth = useAuthStore()
    auth.setSession("alpha", "tok-a", null, false)
    auth.setActiveContext("alpha")

    const wrapper = mount(ClusterSelector)
    await wrapper.find("button").trigger("click")
    const badges = wrapper
      .findAll("[role='option']")
      .map((o) => o.text().includes("signed in"))
    expect(badges).toEqual([true, false])
  })

  it("drops the mark once the session for that context ends", async () => {
    mockContexts(["alpha", "beta"])
    const auth = useAuthStore()
    auth.setSession("alpha", "tok-a", null, false)
    auth.setSession("beta", "tok-b", null, false)
    auth.setActiveContext("beta")
    auth.clearActiveSession() // e.g. a 401 for beta only

    const wrapper = mount(ClusterSelector)
    await wrapper.find("button").trigger("click")
    const options = wrapper.findAll("[role='option']")
    expect(options[0]!.text()).toContain("signed in")
    expect(options[1]!.text()).not.toContain("signed in")
  })

  it("closes the list after picking a context", async () => {
    mockContexts(["alpha", "beta"])
    const auth = useAuthStore()
    auth.setSession("alpha", "tok-a", null, false)
    auth.setSession("beta", "tok-b", null, false)
    auth.setActiveContext("alpha")

    const wrapper = mount(ClusterSelector)
    await pick(wrapper, "beta")

    expect(wrapper.findAll("[role='option']")).toHaveLength(0)
  })

  it("stays on a list route when switching to an authorized context", async () => {
    mockContexts(["alpha", "beta"])
    const auth = useAuthStore()
    auth.setSession("alpha", "tok-a", null, false)
    auth.setSession("beta", "tok-b", null, false)
    auth.setActiveContext("alpha")

    const wrapper = mount(ClusterSelector)
    await pick(wrapper, "beta")

    expect(auth.activeContext).toBe("beta")
    // No navigation: the list refetches under context-scoped keys.
    expect(push).not.toHaveBeenCalled()
  })

  it("collapses a detail route to its list on switch", async () => {
    mockContexts(["alpha", "beta"])
    mockRoute = {
      name: "resource-detail",
      params: { group: "apps", version: "v1", resource: "deployments", namespace: "prod", name: "api" },
      fullPath: "/r/apps/v1/deployments/prod/api",
    }
    const auth = useAuthStore()
    auth.setSession("alpha", "tok-a", null, false)
    auth.setSession("beta", "tok-b", null, false)
    auth.setActiveContext("alpha")

    const wrapper = mount(ClusterSelector)
    await pick(wrapper, "beta")

    expect(push).toHaveBeenCalledWith({
      name: "resource-list",
      params: { group: "apps", version: "v1", resource: "deployments" },
    })
  })

  it("redirects to login when switching to an unauthorized context, keeping the place", async () => {
    mockContexts(["alpha", "beta"])
    const auth = useAuthStore()
    auth.setSession("alpha", "tok-a", null, false)
    auth.setActiveContext("alpha")

    const wrapper = mount(ClusterSelector)
    await pick(wrapper, "beta")

    expect(auth.activeContext).toBe("beta")
    expect(push).toHaveBeenCalledWith({ name: "login", query: { redirect: "/r/core/v1/pods" } })
  })

  // Regression: an expired session used to read as authenticated (a token was
  // present), so switching to a stale cluster stayed on the page and fired
  // tokenless requests instead of asking for a new token.
  it("redirects to login when switching to a context whose session expired", async () => {
    mockContexts(["alpha", "beta"])
    const auth = useAuthStore()
    auth.setSession("beta", "tok-b", null, false)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000)
      auth.setSession("alpha", "tok-a", null, false)

      const wrapper = mount(ClusterSelector)
      await pick(wrapper, "beta")

      expect(auth.activeContext).toBe("beta")
      expect(auth.isAuthenticated).toBe(false)
      expect(push).toHaveBeenCalledWith({ name: "login", query: { redirect: "/r/core/v1/pods" } })
      // The stale token is dropped, not just ignored.
      expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY) ?? "").not.toContain("tok-b")
    } finally {
      vi.useRealTimers()
    }
  })

  it("login redirect from a detail route collapses to its list", async () => {
    mockContexts(["alpha", "beta"])
    mockRoute = {
      name: "resource-detail",
      params: { group: "apps", version: "v1", resource: "deployments", namespace: "prod", name: "api" },
      fullPath: "/r/apps/v1/deployments/prod/api",
    }
    const auth = useAuthStore()
    auth.setSession("alpha", "tok-a", null, false)
    auth.setActiveContext("alpha")

    const wrapper = mount(ClusterSelector)
    await pick(wrapper, "beta")

    expect(push).toHaveBeenCalledWith({
      name: "login",
      query: { redirect: "/r/apps/v1/deployments" },
    })
  })
})
