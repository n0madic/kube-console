import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

import type { K8sObjectList } from "@/api/types"

vi.mock("@/composables/useDiscovery", () => ({ useDiscovery: vi.fn() }))

// The namespace query hits the API; a hoisted holder lets each test drive the
// returned list (and error state) that the mocked useQuery yields.
const state = vi.hoisted(() => ({
  data: undefined as unknown,
  isError: undefined as unknown,
}))
vi.mock("@tanstack/vue-query", () => ({
  useQuery: () => ({ data: state.data, isError: state.isError }),
}))

let mockRoute: { name: string; params: Record<string, string> }
vi.mock("vue-router", () => ({ useRoute: () => mockRoute }))

import { useDiscovery } from "@/composables/useDiscovery"
import NamespaceSelector from "@/components/layout/NamespaceSelector.vue"
import { useUiStore } from "@/stores/ui"

const mockedDiscovery = vi.mocked(useDiscovery)

function mockDiscovery(namespaced: boolean | undefined) {
  mockedDiscovery.mockReturnValue({
    findResource: () =>
      namespaced === undefined ? undefined : { namespaced },
  } as unknown as ReturnType<typeof useDiscovery>)
}

function setNamespaces(names: string[] | undefined, isError = false, continueToken = ""): void {
  state.data = ref<K8sObjectList | undefined>(
    names === undefined
      ? undefined
      : {
          items: names.map((name) => ({ metadata: { name } })),
          ...(continueToken !== "" ? { metadata: { continue: continueToken } } : {}),
        },
  )
  state.isError = ref(isError)
}

describe("NamespaceSelector", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedDiscovery.mockReset()
    setNamespaces([])
  })

  it("hides the selector for a cluster-scoped resource", () => {
    mockRoute = { name: "resource-list", params: { group: "core", version: "v1", resource: "nodes" } }
    mockDiscovery(false)
    const wrapper = mount(NamespaceSelector)
    expect(wrapper.find("select").exists()).toBe(false)
    expect(wrapper.text()).not.toContain("Namespace")
  })

  it("shows the selector for a namespaced resource", () => {
    mockRoute = { name: "resource-list", params: { group: "core", version: "v1", resource: "pods" } }
    mockDiscovery(true)
    const wrapper = mount(NamespaceSelector)
    expect(wrapper.find("select").exists()).toBe(true)
  })

  it("keeps the selector on non-resource routes (e.g. overview)", () => {
    mockRoute = { name: "overview", params: {} }
    mockDiscovery(undefined)
    const wrapper = mount(NamespaceSelector)
    expect(wrapper.find("select").exists()).toBe(true)
  })

  it("keeps the selector while discovery is still loading (entry unknown)", () => {
    mockRoute = { name: "resource-list", params: { group: "core", version: "v1", resource: "nodes" } }
    mockDiscovery(undefined)
    const wrapper = mount(NamespaceSelector)
    expect(wrapper.find("select").exists()).toBe(true)
  })

  it("keeps a same-named namespace when the new cluster has it", () => {
    mockRoute = { name: "overview", params: {} }
    mockDiscovery(undefined)
    const ui = useUiStore()
    ui.namespace = "prod"
    setNamespaces(["default", "prod", "kube-system"])
    mount(NamespaceSelector)
    expect(ui.namespace).toBe("prod")
  })

  it("resets to all namespaces when the selected one is absent in the new cluster", () => {
    mockRoute = { name: "overview", params: {} }
    mockDiscovery(undefined)
    const ui = useUiStore()
    ui.namespace = "prod"
    setNamespaces(["default", "kube-system"])
    mount(NamespaceSelector)
    expect(ui.namespace).toBe("")
  })

  it("leaves the namespace untouched when the list errors (free-text fallback)", () => {
    mockRoute = { name: "overview", params: {} }
    mockDiscovery(undefined)
    const ui = useUiStore()
    ui.namespace = "prod"
    setNamespaces(undefined, true)
    mount(NamespaceSelector)
    expect(ui.namespace).toBe("prod")
  })

  // Regression: a truncated page (cluster with >500 namespaces) cannot prove a
  // namespace is absent, so a valid selection beyond the first page must not
  // be reset to "all".
  it("leaves the namespace untouched when the list is truncated (continue token)", () => {
    mockRoute = { name: "overview", params: {} }
    mockDiscovery(undefined)
    const ui = useUiStore()
    ui.namespace = "zzz-team"
    setNamespaces(["default", "kube-system"], false, "next-page-token")
    mount(NamespaceSelector)
    expect(ui.namespace).toBe("zzz-team")
  })
})
