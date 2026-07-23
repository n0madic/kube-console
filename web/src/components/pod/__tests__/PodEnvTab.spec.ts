import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/api/k8s", () => ({ getObject: vi.fn() }))

import { getObject } from "@/api/k8s"
import type { K8sObject } from "@/api/types"
import PodEnvTab from "@/components/pod/PodEnvTab.vue"
import { useAuthStore } from "@/stores/auth"

const mockedGet = vi.mocked(getObject)
let queryClient: QueryClient

function b64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
}

const pod: K8sObject = {
  kind: "Pod",
  metadata: { name: "web", namespace: "prod", uid: "p1" },
  spec: {
    containers: [
      {
        name: "app",
        env: [
          { name: "PLAIN", value: "hello" },
          { name: "PASSWORD", valueFrom: { secretKeyRef: { name: "sec", key: "PASSWORD" } } },
          { name: "HOST", valueFrom: { configMapKeyRef: { name: "cfg", key: "HOST" } } },
        ],
      },
    ],
  },
} as unknown as K8sObject

// A second Pod referencing a different ConfigMap/Secret pair, so switching to
// it must miss the cache (different name set = different query key).
const otherPod: K8sObject = {
  kind: "Pod",
  metadata: { name: "api", namespace: "prod", uid: "p2" },
  spec: {
    containers: [
      {
        name: "app",
        env: [
          { name: "HOST", valueFrom: { configMapKeyRef: { name: "cfg2", key: "HOST" } } },
          { name: "PASSWORD", valueFrom: { secretKeyRef: { name: "sec2", key: "PASSWORD" } } },
        ],
      },
    ],
  },
} as unknown as K8sObject

// ref is guarded because @vue/test-utils issues a stray teardown call with no
// arguments after the test body; it does not affect the assertions above it.
function resolveFixtures(): void {
  mockedGet.mockImplementation((ref, _ns, name) => {
    if (ref?.resource === "configmaps" && name === "cfg") {
      return Promise.resolve({ data: { HOST: "db.local" } } as K8sObject)
    }
    if (ref?.resource === "secrets" && name === "sec") {
      return Promise.resolve({ data: { PASSWORD: b64("s3cr3t") } } as K8sObject)
    }
    if (ref?.resource === "configmaps" && name === "cfg2") {
      return Promise.resolve({ data: { HOST: "other.local" } } as K8sObject)
    }
    if (ref?.resource === "secrets" && name === "sec2") {
      return Promise.resolve({ data: { PASSWORD: b64("0th3r") } } as K8sObject)
    }
    return Promise.resolve({ data: {} } as K8sObject)
  })
}

function mountTab() {
  return mount(PodEnvTab, {
    props: { object: pod },
    global: {
      plugins: [[VueQueryPlugin, { queryClient }]],
      stubs: { RouterLink: { props: ["to"], template: "<a :data-to='JSON.stringify(to)'><slot /></a>" } },
    },
  })
}

describe("PodEnvTab", () => {
  beforeEach(() => {
    mockedGet.mockReset()
    // The auth store mirrors sessions into sessionStorage; start every test
    // from an empty tab so a previous test's token is never restored.
    window.sessionStorage.clear()
    setActivePinia(createPinia())
    // Same defaults the app ships (main.ts), so the cache behaviour asserted
    // below is the one that actually runs in the browser.
    queryClient = new QueryClient({
      defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
    })
    // The env-source queries are gated on an authenticated session (matches
    // the rest of the app's context-scoped queries).
    useAuthStore().setSession("test-ctx", "TOKEN", null, false)
  })

  it("gathers env vars sorted by name, with the secret value masked", async () => {
    resolveFixtures()
    const wrapper = mountTab()
    await flushPromises()

    const names = wrapper.findAll("tbody tr td:first-child").map((td) => td.text())
    expect(names).toEqual(["HOST", "PASSWORD", "PLAIN"])

    expect(wrapper.text()).toContain("db.local")
    expect(wrapper.text()).toContain("hello")
    // Secret stays masked until revealed.
    expect(wrapper.text()).toContain("••••••••")
    expect(wrapper.text()).not.toContain("s3cr3t")
  })

  it("links the source resource name to its detail page", async () => {
    resolveFixtures()
    const wrapper = mountTab()
    await flushPromises()

    const links = wrapper.findAll("a").map((a) => a.attributes("data-to") ?? "")
    // HOST comes from ConfigMap "cfg", PASSWORD from Secret "sec".
    expect(links.some((to) => to.includes("configmaps") && to.includes("cfg"))).toBe(true)
    expect(links.some((to) => to.includes("secrets") && to.includes("sec"))).toBe(true)
    // No "(envFrom)" qualifier in the source column anymore.
    expect(wrapper.text()).not.toContain("envFrom")
  })

  it("decodes the secret value only after the eye button is clicked", async () => {
    resolveFixtures()
    const wrapper = mountTab()
    await flushPromises()

    // Only the secret row has an eye button (short values need no expand button).
    await wrapper.find("button").trigger("click")
    expect(wrapper.text()).toContain("s3cr3t")
    expect(wrapper.text()).not.toContain("••••••••")
  })

  it("marks a forbidden Secret as unreadable instead of failing the tab", async () => {
    mockedGet.mockImplementation((ref, _ns, name) => {
      if (ref?.resource === "configmaps" && name === "cfg") {
        return Promise.resolve({ data: { HOST: "db.local" } } as K8sObject)
      }
      if (ref?.resource === "secrets") return Promise.reject(new Error("forbidden"))
      return Promise.resolve({ data: {} } as K8sObject)
    })
    const wrapper = mountTab()
    await flushPromises()

    expect(wrapper.text()).toContain("(cannot read secret)")
    // No eye button when there is nothing decodable.
    expect(wrapper.find("button").exists()).toBe(false)
    // The rest of the table still renders.
    expect(wrapper.text()).toContain("db.local")
  })

  // A gated-off session (past its TTL) leaves the queries disabled and their
  // data undefined. That must never render as "No environment variables." —
  // the Pod does declare them, they simply were not fetched.
  it("does not claim the Pod has no env vars while the sources are unresolved", async () => {
    resolveFixtures()
    useAuthStore().clearSession("test-ctx")
    const wrapper = mountTab()
    await flushPromises()

    expect(mockedGet).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain("No environment variables.")
    expect(wrapper.text()).toContain("Loading...")
  })

  // Regression: the Env tab is v-else-if in ResourceDetailPage, so switching
  // tabs away and back unmounts and remounts this component. The ConfigMap/
  // Secret data must come from the cache of the app-wide QueryClient, not a
  // fresh fetch, while the entry is still fresh (ENV_SOURCE_STALE_TIME).
  it("does not refetch ConfigMaps/Secrets on remount while the query cache is warm", async () => {
    resolveFixtures()
    const first = mountTab()
    await flushPromises()
    expect(mockedGet).toHaveBeenCalledTimes(2) // one ConfigMap, one Secret
    first.unmount()

    const second = mountTab()
    await flushPromises()

    expect(mockedGet).toHaveBeenCalledTimes(2) // still 2: served from cache
    expect(second.text()).toContain("db.local")
    expect(second.text()).toContain("••••••••")
    second.unmount()
  })

  // Navigating Pod → Pod reuses this component instance (same v-else-if slot),
  // so the cache key must follow the new Pod's name set and the previous Pod's
  // revealed Secret must be masked again.
  it("refetches and re-masks when the Pod switches to different sources", async () => {
    resolveFixtures()
    const wrapper = mountTab()
    await flushPromises()
    await wrapper.find("button").trigger("click")
    expect(wrapper.text()).toContain("s3cr3t")

    await wrapper.setProps({ object: otherPod })
    await flushPromises()

    expect(mockedGet.mock.calls.map((c) => c[2])).toContain("cfg2")
    expect(wrapper.text()).toContain("other.local")
    expect(wrapper.text()).not.toContain("s3cr3t")
    expect(wrapper.text()).not.toContain("0th3r")
    expect(wrapper.text()).toContain("••••••••")
    wrapper.unmount()
  })
})
