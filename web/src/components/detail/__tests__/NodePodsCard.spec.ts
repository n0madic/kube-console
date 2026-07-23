import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/api/k8s", () => ({ listAllAsTable: vi.fn() }))

import { listAllAsTable } from "@/api/k8s"
import type { K8sObject, K8sTable } from "@/api/types"
import NodePodsCard from "@/components/detail/NodePodsCard.vue"

const mockedTable = vi.mocked(listAllAsTable)

const podTable: K8sTable = {
  kind: "Table",
  columnDefinitions: [
    { name: "Name", type: "string" },
    { name: "Ready", type: "string" },
    { name: "Status", type: "string" },
    { name: "Restarts", type: "string" },
    { name: "Age", type: "string" },
    { name: "IP", type: "string", priority: 1 },
    { name: "Node", type: "string", priority: 1 },
  ],
  rows: [
    {
      cells: ["web-1", "1/1", "Running", "0", "5d", "10.1.0.7", "node-1"],
      object: { metadata: { name: "web-1", namespace: "default" } },
    },
    {
      cells: ["job-x", "0/1", "CrashLoopBackOff", "8", "3h", "10.1.0.9", "node-1"],
      object: { metadata: { name: "job-x", namespace: "kube-system" } },
    },
  ],
}

function mountFor(object: K8sObject) {
  return mount(NodePodsCard, {
    props: { object },
    global: { stubs: { RouterLink: { props: ["to"], template: "<a><slot /></a>" } } },
  })
}

const node: K8sObject = { apiVersion: "v1", kind: "Node", metadata: { name: "node-1", uid: "u1" } }

describe("NodePodsCard", () => {
  beforeEach(() => mockedTable.mockReset())

  it("queries pods on the node via the spec.nodeName field selector", async () => {
    mockedTable.mockResolvedValue({ table: podTable, truncated: false })
    mountFor(node)
    await flushPromises()
    expect(mockedTable).toHaveBeenCalledWith(
      { group: "", version: "v1", resource: "pods" },
      expect.objectContaining({ fieldSelector: "spec.nodeName=node-1" }),
    )
  })

  it("renders a table with important columns and no Node column", async () => {
    mockedTable.mockResolvedValue({ table: podTable, truncated: false })
    const wrapper = mountFor(node)
    await flushPromises()

    const headers = wrapper.findAll("th").map((th) => th.text())
    expect(headers).toEqual(["Namespace", "Name", "Ready", "Status", "Restarts", "Age", "IP"])
    expect(headers).not.toContain("Node")

    expect(wrapper.text()).toContain("Pods")
    expect(wrapper.text()).toContain("(2)")
    expect(wrapper.text()).toContain("default")
    expect(wrapper.text()).toContain("web-1")
    expect(wrapper.text()).toContain("CrashLoopBackOff")
  })

  it("colors an error status red", async () => {
    mockedTable.mockResolvedValue({ table: podTable, truncated: false })
    const wrapper = mountFor(node)
    await flushPromises()
    const crashCell = wrapper.findAll("td").find((td) => td.text() === "CrashLoopBackOff")
    expect(crashCell?.classes().join(" ")).toContain("text-red")
  })

  it("marks the count with '+' when the scan was truncated", async () => {
    mockedTable.mockResolvedValue({ table: podTable, truncated: true })
    const wrapper = mountFor(node)
    await flushPromises()
    expect(wrapper.text()).toContain("(2+)")
  })

  it("reloads when the page hands over a refreshed object with the same uid", async () => {
    mockedTable.mockResolvedValue({ table: podTable, truncated: false })
    const wrapper = mountFor(node)
    await flushPromises()
    expect(mockedTable).toHaveBeenCalledTimes(1)

    // What Refresh / a cordon-uncordon action does: same node, new object.
    await wrapper.setProps({ object: { ...node, spec: { unschedulable: true } } })
    await flushPromises()
    expect(mockedTable).toHaveBeenCalledTimes(2)
  })

  it("renders nothing when the node has no pods", async () => {
    mockedTable.mockResolvedValue({
      table: { kind: "Table", columnDefinitions: [], rows: [] },
      truncated: false,
    })
    const wrapper = mountFor(node)
    await flushPromises()
    expect(wrapper.find("section").exists()).toBe(false)
  })
})
