import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

import type { ContextInfo } from "@/api/types"

const push = vi.fn()
const query: Record<string, string> = {}
vi.mock("vue-router", () => ({
  useRoute: () => ({ query }),
  useRouter: () => ({ push }),
}))
vi.mock("@/api/ui", () => ({ verifyToken: vi.fn() }))
// The contexts query is gated on being authenticated, so on this page it only
// ever replays what the cache already holds (empty by default here).
const cachedContexts = ref<ContextInfo[]>([])
vi.mock("@/composables/useContexts", () => ({
  useContexts: () => ({ contexts: cachedContexts }),
}))

import { ApiError } from "@/api/http"
import { verifyToken } from "@/api/ui"
import LoginPage from "@/pages/LoginPage.vue"
import { useAuthStore } from "@/stores/auth"

const mockedVerify = vi.mocked(verifyToken)

function mountPage() {
  return mount(LoginPage, {
    global: { stubs: { BaseButton: { template: "<button><slot /></button>" } } },
  })
}

/** The context picker is a custom listbox: open it, then click an option. */
async function pickContext(wrapper: ReturnType<typeof mountPage>, name: string) {
  await wrapper.get('[data-testid="login-context"] button').trigger("click")
  const option = wrapper
    .findAll("[role='option']")
    .find((o) => o.get('[data-testid="ctx-name"]').text() === name)
  if (option === undefined) throw new Error(`option ${name} not rendered`)
  await option.trigger("click")
}

describe("LoginPage cluster context", () => {
  // A page left mounted keeps rendering against the previous test's pinia (and
  // the picker's document listener), which leaks state into the next test.
  enableAutoUnmount(afterEach)

  beforeEach(() => {
    window.sessionStorage.clear()
    setActivePinia(createPinia())
    mockedVerify.mockReset()
    push.mockReset()
    cachedContexts.value = []
    for (const key of Object.keys(query)) delete query[key]
  })

  it("names the context being signed into", () => {
    useAuthStore().setActiveContext("cluster-alpha")
    const wrapper = mountPage()

    expect(wrapper.get('[data-testid="login-context"]').text()).toBe("cluster-alpha")
  })

  // First login of a tab: the context list is behind a bearer token, so the
  // name is unknown until the server resolves its default on verify.
  it("falls back to 'server default' when no context is selected yet", () => {
    const wrapper = mountPage()

    expect(wrapper.get('[data-testid="login-context"]').text()).toBe("server default")
  })

  it("verifies against the named context and stores the resolved one", async () => {
    const auth = useAuthStore()
    auth.setActiveContext("cluster-alpha")
    mockedVerify.mockResolvedValue({ authenticated: true, context: "cluster-alpha" })

    const wrapper = mountPage()
    await wrapper.get("#token").setValue("tok-1")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(mockedVerify).toHaveBeenCalledWith("tok-1", "cluster-alpha")
    expect(auth.activeContext).toBe("cluster-alpha")
    expect(auth.isAuthenticated).toBe(true)
  })

  // Landing here by an accidental switch must not be a dead end: the sidebar
  // switcher is not rendered on this page.
  it("lists the still-signed-in contexts even with an empty query cache", async () => {
    const auth = useAuthStore()
    auth.setSession("cluster-alpha", "tok-alpha", null, false)
    auth.setActiveContext("kube-beta")

    const wrapper = mountPage()
    await wrapper.get('[data-testid="login-context"] button').trigger("click")
    const options = wrapper.findAll("[role='option']")

    expect(options.map((o) => o.get('[data-testid="ctx-name"]').text())).toEqual([
      "cluster-alpha",
      "kube-beta",
    ])
    // Same mark as the sidebar switcher: only alpha has a token in this tab.
    expect(options[0]!.text()).toContain("signed in")
    expect(options[1]!.text()).not.toContain("signed in")
  })

  // The union of query cache + tab sessions has no natural order; sorting is
  // what makes this picker match the sidebar switcher.
  it("sorts and dedupes the union of both name sources", async () => {
    const auth = useAuthStore()
    auth.setSession("staging", "tok-staging", null, false)
    auth.setActiveContext("prod")
    cachedContexts.value = [{ name: "staging" }, { name: "dev" }]

    const wrapper = mountPage()
    await wrapper.get('[data-testid="login-context"] button').trigger("click")

    expect(
      wrapper.findAll("[role='option']").map((o) => o.get('[data-testid="ctx-name"]').text()),
    ).toEqual(["dev", "prod", "staging"])
  })

  it("picking a signed-in context resumes without a token", async () => {
    const auth = useAuthStore()
    auth.setSession("cluster-alpha", "tok-alpha", null, false)
    auth.setActiveContext("kube-beta")
    query.redirect = "/r/core/v1/pods"

    const wrapper = mountPage()
    await pickContext(wrapper, "cluster-alpha")

    expect(auth.activeContext).toBe("cluster-alpha")
    expect(auth.isAuthenticated).toBe(true)
    expect(push).toHaveBeenCalledWith("/r/core/v1/pods")
    expect(mockedVerify).not.toHaveBeenCalled()
  })

  it("picking an unauthorized context stays here and rebinds the form", async () => {
    const auth = useAuthStore()
    auth.setActiveContext("kube-beta")
    cachedContexts.value = [{ name: "kube-beta" }, { name: "kube-gamma" }]
    mockedVerify.mockResolvedValue({ authenticated: true, context: "kube-gamma" })

    const wrapper = mountPage()
    await pickContext(wrapper, "kube-gamma")

    expect(auth.activeContext).toBe("kube-gamma")
    expect(push).not.toHaveBeenCalled()

    await wrapper.get("#token").setValue("tok-gamma")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(mockedVerify).toHaveBeenCalledWith("tok-gamma", "kube-gamma")
  })

  // `redirect` is attacker-controllable via the URL; a protocol-relative value
  // would reach history.pushState as an off-site location.
  it.each(["//evil.example.com", "/\\evil.example.com", "https://evil.example.com"])(
    "ignores an off-site redirect (%s)",
    async (redirect) => {
      useAuthStore().setActiveContext("cluster-alpha")
      query.redirect = redirect
      mockedVerify.mockResolvedValue({ authenticated: true, context: "cluster-alpha" })

      const wrapper = mountPage()
      await wrapper.get("#token").setValue("tok-1")
      await wrapper.get("form").trigger("submit")
      await flushPromises()

      expect(push).toHaveBeenCalledWith("/overview")
    },
  )

  // The verify ends with setSession(), which activates the context it was
  // started for — a switch made meanwhile would be silently undone.
  it("ignores a context pick while a verify is in flight", async () => {
    const auth = useAuthStore()
    auth.setSession("cluster-alpha", "tok-alpha", null, false)
    auth.setActiveContext("kube-beta")
    let resolveVerify: (v: { authenticated: boolean; context: string }) => void = () => {}
    mockedVerify.mockReturnValue(
      new Promise((resolve) => {
        resolveVerify = resolve
      }),
    )

    const wrapper = mountPage()
    await wrapper.get("#token").setValue("tok-beta")
    await wrapper.get("form").trigger("submit")
    await pickContext(wrapper, "cluster-alpha")

    expect(auth.activeContext).toBe("kube-beta")
    expect(push).not.toHaveBeenCalled()

    resolveVerify({ authenticated: true, context: "kube-beta" })
    await flushPromises()
    expect(auth.activeContext).toBe("kube-beta")
  })

  it("drops the previous context's rejection when picking another one", async () => {
    const auth = useAuthStore()
    auth.setActiveContext("kube-beta")
    cachedContexts.value = [{ name: "kube-beta" }, { name: "kube-gamma" }]
    mockedVerify.mockRejectedValue(new ApiError(401, "unauthorized"))

    const wrapper = mountPage()
    await wrapper.get("#token").setValue("bad")
    await wrapper.get("form").trigger("submit")
    await flushPromises()
    expect(wrapper.text()).toContain("rejected by the cluster")

    await pickContext(wrapper, "kube-gamma")
    expect(wrapper.text()).not.toContain("rejected by the cluster")
  })

  it("shows a plain name, not a picker, when only one context is known", () => {
    useAuthStore().setActiveContext("kube-beta")

    expect(mountPage().find('[data-testid="login-context"] button').exists()).toBe(false)
  })
})
