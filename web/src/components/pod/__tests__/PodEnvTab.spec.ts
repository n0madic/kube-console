import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/api/k8s", () => ({ getObject: vi.fn() }))

import { getObject } from "@/api/k8s"
import type { K8sObject } from "@/api/types"
import PodEnvTab from "@/components/pod/PodEnvTab.vue"

const mockedGet = vi.mocked(getObject)

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
    return Promise.resolve({ data: {} } as K8sObject)
  })
}

function mountTab() {
  return mount(PodEnvTab, {
    props: { object: pod },
    global: { stubs: { RouterLink: { props: ["to"], template: "<a :data-to='JSON.stringify(to)'><slot /></a>" } } },
  })
}

describe("PodEnvTab", () => {
  beforeEach(() => mockedGet.mockReset())

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
})
