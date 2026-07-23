import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"

const findByKind = vi.fn()
const findByLowerKind = vi.fn()
vi.mock("@/composables/useDiscovery", () => ({
  useDiscovery: () => ({ findByKind, findByLowerKind }),
}))

import type { DiscoveryResource } from "@/api/types"
import ObjectFieldTree from "@/components/detail/ObjectFieldTree.vue"
import { buildFieldTree } from "@/utils/fieldTree"

const stubs = {
  RouterLink: { name: "RouterLink", props: ["to"], template: "<a><slot /></a>" },
}

describe("ObjectFieldTree", () => {
  beforeEach(() => {
    findByKind.mockReset()
    findByLowerKind.mockReset()
  })

  it("renders leaves, chips and nested groups", () => {
    const nodes = buildFieldTree({
      replicas: 2,
      args: ["serve", "--v=2"],
      strategy: { type: "RollingUpdate" },
    })
    const wrapper = mount(ObjectFieldTree, { props: { nodes }, global: { stubs } })
    expect(wrapper.text()).toContain("Replicas")
    expect(wrapper.text()).toContain("2")
    expect(wrapper.text()).toContain("serve")
    // Small group is expanded by default.
    expect(wrapper.text()).toContain("RollingUpdate")
  })

  it("collapses big subtrees by default and expands on click", async () => {
    const big: Record<string, number> = {}
    for (let i = 0; i < 30; i++) big[`field${i}`] = i
    const nodes = buildFieldTree({ template: big })
    const wrapper = mount(ObjectFieldTree, { props: { nodes }, global: { stubs } })
    expect(wrapper.text()).not.toContain("Field7")
    await wrapper.find("button").trigger("click")
    expect(wrapper.text()).toContain("Field7")
  })

  it("collapses long values behind an expand button", async () => {
    const value = "X".repeat(300)
    const nodes = buildFieldTree({ caBundle: value })
    const wrapper = mount(ObjectFieldTree, { props: { nodes }, global: { stubs } })
    expect(wrapper.text()).not.toContain(value)
    expect(wrapper.text()).toContain("expand (300 chars)")
    await wrapper.find("button").trigger("click")
    expect(wrapper.find("pre").text()).toBe(value)
  })

  it("collapses long chip values behind an expand button", async () => {
    const value = `--config=${"x".repeat(300)}`
    const nodes = buildFieldTree({ args: [value] })
    const wrapper = mount(ObjectFieldTree, { props: { nodes }, global: { stubs } })
    expect(wrapper.text()).not.toContain(value)
    expect(wrapper.text()).toContain(`expand (${value.length})`)
    await wrapper.find("button").trigger("click")
    expect(wrapper.text()).toContain(value)
  })

  it("collapses long table cell values behind an expand button", async () => {
    const value = "K".repeat(2000)
    const nodes = buildFieldTree({
      env: [
        { name: "HOST", value: "https://example.com" },
        { name: "RSA_KEY", value },
      ],
    })
    const wrapper = mount(ObjectFieldTree, { props: { nodes }, global: { stubs } })
    expect(wrapper.text()).toContain("https://example.com")
    expect(wrapper.text()).not.toContain(value)
    expect(wrapper.text()).toContain("expand (2000)")
    await wrapper.find("td button").trigger("click")
    expect(wrapper.find("td pre").text()).toBe(value)
  })

  it("color-codes status values in one class expression", () => {
    const nodes = buildFieldTree({ phase: "Failed" })
    const wrapper = mount(ObjectFieldTree, { props: { nodes }, global: { stubs } })
    const valueSpan = wrapper.find("dd span")
    expect(valueSpan.classes().join(" ")).toContain("text-red-600")
    expect(valueSpan.classes().join(" ")).not.toContain("text-slate-700")
  })
})

describe("ObjectFieldTree object references", () => {
  beforeEach(() => {
    findByKind.mockReset()
    findByLowerKind.mockReset()
  })

  const podEntry: DiscoveryResource = {
    id: "core/v1/pods",
    group: "",
    version: "v1",
    resource: "pods",
    kind: "Pod",
    namespaced: true,
  }

  function mountTree(value: Record<string, unknown>, namespace?: string) {
    return mount(ObjectFieldTree, {
      props: { nodes: buildFieldTree(value), namespace },
      global: { stubs },
    })
  }

  it("links the name of a kind+name reference (Event involvedObject)", () => {
    findByKind.mockReturnValue(podEntry)
    const wrapper = mountTree({
      involvedObject: { kind: "Pod", apiVersion: "v1", namespace: "prod", name: "nginx-abc" },
    })
    const link = wrapper.findComponent({ name: "RouterLink" })
    expect(link.exists()).toBe(true)
    expect(link.text()).toBe("nginx-abc")
    expect(link.props("to")).toEqual({
      name: "resource-detail",
      params: {
        group: "core",
        version: "v1",
        resource: "pods",
        namespace: "prod",
        name: "nginx-abc",
      },
    })
    // Sibling fields stay plain text.
    expect(wrapper.text()).toContain("Pod")
  })

  it("falls back to the object's own namespace for a ref that carries none", () => {
    findByLowerKind.mockReturnValue({
      id: "rbac.authorization.k8s.io/v1/roles",
      group: "rbac.authorization.k8s.io",
      version: "v1",
      resource: "roles",
      kind: "Role",
      namespaced: true,
    })
    const wrapper = mountTree(
      { roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "reader" } },
      "prod",
    )
    expect(findByLowerKind).toHaveBeenCalledWith("Role", "rbac.authorization.k8s.io")
    const link = wrapper.findComponent({ name: "RouterLink" })
    expect((link.props("to") as { params: { namespace: string } }).params.namespace).toBe("prod")
  })

  it("resolves a cluster-scoped ref without any namespace", () => {
    findByKind.mockReturnValue({
      id: "core/v1/nodes",
      group: "",
      version: "v1",
      resource: "nodes",
      kind: "Node",
      namespaced: false,
    })
    const wrapper = mountTree({
      involvedObject: { kind: "Node", apiVersion: "v1", name: "node-a" },
    })
    const link = wrapper.findComponent({ name: "RouterLink" })
    expect((link.props("to") as { params: { namespace: string } }).params.namespace).toBe("_")
  })

  it("renders plain text when the kind is not discoverable", () => {
    findByKind.mockReturnValue(undefined)
    findByLowerKind.mockReturnValue(undefined)
    const wrapper = mountTree({
      involvedObject: { kind: "Widget", apiVersion: "acme.io/v1", namespace: "prod", name: "w1" },
    })
    expect(wrapper.findComponent({ name: "RouterLink" }).exists()).toBe(false)
    expect(wrapper.text()).toContain("w1")
  })

  it("renders plain text for a namespaced ref with no namespace anywhere", () => {
    findByKind.mockReturnValue(podEntry)
    const wrapper = mountTree({ involvedObject: { kind: "Pod", apiVersion: "v1", name: "nginx" } })
    expect(wrapper.findComponent({ name: "RouterLink" }).exists()).toBe(false)
  })

  it("leaves a name that is not part of a reference plain", () => {
    const wrapper = mountTree({ port: { name: "http", containerPort: 8080 } })
    expect(wrapper.findComponent({ name: "RouterLink" }).exists()).toBe(false)
    expect(findByKind).not.toHaveBeenCalled()
    expect(findByLowerKind).not.toHaveBeenCalled()
  })
})
