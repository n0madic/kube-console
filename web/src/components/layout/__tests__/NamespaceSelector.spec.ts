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
  options: undefined as Record<string, unknown> | undefined,
}))
vi.mock("@tanstack/vue-query", () => ({
  useQuery: (options: Record<string, unknown>) => {
    state.options = options
    return { data: state.data, isError: state.isError }
  },
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

  // Regression: a selection past the fetched pages had no <option>, so the
  // select rendered blank — while every list on screen stayed filtered by it
  // — and the value could not even be reselected from the dropdown.
  it("always renders an option for the selected namespace on a truncated list", () => {
    mockRoute = { name: "overview", params: {} }
    mockDiscovery(undefined)
    const ui = useUiStore()
    ui.namespace = "zzz-team"
    setNamespaces(["default", "kube-system"], false, "next-page-token")
    const wrapper = mount(NamespaceSelector)
    const values = wrapper.findAll("option").map((o) => o.attributes("value"))
    expect(values).toContain("zzz-team")
    expect(wrapper.get("select").element.value).toBe("zzz-team")
  })

  it("marks a truncated list instead of presenting it as complete", () => {
    mockRoute = { name: "overview", params: {} }
    mockDiscovery(undefined)
    setNamespaces(["default"], false, "next-page-token")
    const wrapper = mount(NamespaceSelector)
    const marker = wrapper.findAll("option").find((o) => o.text().includes("not listed"))
    expect(marker).toBeDefined()
    expect(marker?.attributes("disabled")).toBeDefined()
  })

  // Regression: the selector is mounted for the whole session and window-focus
  // refetching is off app-wide, so without an interval a namespace created
  // after the first fetch stayed invisible until a reload or a cluster switch.
  it("polls for namespaces created after the first fetch", () => {
    mockRoute = { name: "overview", params: {} }
    mockDiscovery(undefined)
    mount(NamespaceSelector)
    const interval = state.options?.refetchInterval as (q: unknown) => number | false
    expect(typeof interval).toBe("function")
    expect(interval({ state: { status: "success" } })).toBeGreaterThan(0)
  })

  // A namespace-scoped token's 403 is not retried once; an interval must not
  // reinstate that request every minute for as long as the tab stays open.
  it("stops polling once the list has failed", () => {
    mockRoute = { name: "overview", params: {} }
    mockDiscovery(undefined)
    mount(NamespaceSelector)
    const interval = state.options?.refetchInterval as (q: unknown) => number | false
    expect(interval({ state: { status: "error" } })).toBe(false)
  })

  it("shows no truncation marker for a complete list", () => {
    mockRoute = { name: "overview", params: {} }
    mockDiscovery(undefined)
    setNamespaces(["default", "prod"])
    const wrapper = mount(NamespaceSelector)
    expect(wrapper.text()).not.toContain("not listed")
  })
})
