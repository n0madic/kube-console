import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/api/k8s", () => ({ listAllAsTable: vi.fn() }))

import { listAllAsTable } from "@/api/k8s"
import type { K8sObject, K8sTable } from "@/api/types"
import RelatedResourcesCard from "@/components/detail/RelatedResourcesCard.vue"

const mockedTable = vi.mocked(listAllAsTable)

const rsTable: K8sTable = {
  kind: "Table",
  columnDefinitions: [
    { name: "Name", type: "string" },
    { name: "Desired", type: "integer" },
    { name: "Current", type: "integer" },
    { name: "Ready", type: "integer" },
    { name: "Age", type: "string" },
    { name: "Selector", type: "string", priority: 1 },
  ],
  rows: [
    {
      cells: ["web-abc", 3, 3, 3, "5d", "app=web"],
      object: {
        metadata: {
          name: "web-abc",
          namespace: "prod",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "dep-1" }],
        },
      },
    },
    {
      cells: ["web-old", 0, 0, 0, "20d", "app=web"],
      object: {
        metadata: {
          name: "web-old",
          namespace: "prod",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "other" }],
        },
      },
    },
  ],
}

function mountFor(object: K8sObject) {
  return mount(RelatedResourcesCard, {
    props: { object },
    global: { stubs: { RouterLink: { props: ["to"], template: "<a><slot /></a>" } } },
  })
}

describe("RelatedResourcesCard owner-children table", () => {
  beforeEach(() => mockedTable.mockReset())

  it("renders owned ReplicaSets as a table filtered by ownerReferences.uid", async () => {
    mockedTable.mockResolvedValue({ table: rsTable, truncated: false })
    const deployment: K8sObject = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "web", namespace: "prod", uid: "dep-1" },
      spec: { selector: { matchLabels: { app: "web" } } },
    }
    const wrapper = mountFor(deployment)
    await flushPromises()

    // Query narrowed server-side by the parent selector.
    expect(mockedTable).toHaveBeenCalledWith(
      { group: "apps", version: "v1", resource: "replicasets" },
      expect.objectContaining({ namespace: "prod", labelSelector: "app=web" }),
    )
    // Server priority-0 columns, no Namespace (same as parent), no Name column.
    const headers = wrapper.findAll("th").map((th) => th.text())
    expect(headers).toEqual(["Name", "Desired", "Current", "Ready", "Age"])
    // uid filter keeps only the current ReplicaSet.
    expect(wrapper.text()).toContain("ReplicaSets (1)")
    expect(wrapper.text()).toContain("web-abc")
    expect(wrapper.text()).not.toContain("web-old")
  })

  // Regression: keyed on metadata.uid, a scale/restart followed by the detail
  // page's refresh left the children table showing the pre-action state.
  it("re-scans children when the page hands over a refreshed object", async () => {
    mockedTable.mockResolvedValue({ table: rsTable, truncated: false })
    const deployment: K8sObject = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "web", namespace: "prod", uid: "dep-1" },
      spec: { selector: { matchLabels: { app: "web" } }, replicas: 1 },
    }
    const wrapper = mountFor(deployment)
    await flushPromises()
    const before = mockedTable.mock.calls.length
    expect(before).toBeGreaterThan(0)

    await wrapper.setProps({
      object: { ...deployment, spec: { selector: { matchLabels: { app: "web" } }, replicas: 3 } },
    })
    await flushPromises()
    expect(mockedTable.mock.calls.length).toBe(before * 2)
  })

  it("renders nothing when no child is owned by this object", async () => {
    mockedTable.mockResolvedValue({ table: rsTable, truncated: false })
    const deployment: K8sObject = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "web", namespace: "prod", uid: "nobody" },
      spec: { selector: { matchLabels: { app: "web" } } },
    }
    const wrapper = mountFor(deployment)
    await flushPromises()
    expect(wrapper.find("section").exists()).toBe(false)
  })
})

// ReplicaSet rows carrying uids so the Deployment can resolve its grandchild pods.
const rsWithUid: K8sTable = {
  kind: "Table",
  columnDefinitions: [
    { name: "Name", type: "string" },
    { name: "Desired", type: "integer" },
    { name: "Current", type: "integer" },
    { name: "Ready", type: "integer" },
    { name: "Age", type: "string" },
  ],
  rows: [
    {
      cells: ["web-abc", 3, 3, 3, "5d"],
      object: {
        metadata: {
          name: "web-abc",
          namespace: "prod",
          uid: "rs-1",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "dep-1" }],
        },
      },
    },
  ],
}

const podsTable: K8sTable = {
  kind: "Table",
  columnDefinitions: [
    { name: "Name", type: "string" },
    { name: "Ready", type: "string" },
    { name: "Status", type: "string" },
    { name: "Restarts", type: "integer" },
    { name: "Age", type: "string" },
  ],
  rows: [
    {
      cells: ["web-abc-p1", "1/1", "Running", 0, "5d"],
      object: {
        metadata: {
          name: "web-abc-p1",
          namespace: "prod",
          uid: "pod-1",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-abc", uid: "rs-1" }],
        },
      },
    },
    {
      cells: ["foreign-p2", "1/1", "Running", 0, "5d"],
      object: {
        metadata: {
          name: "foreign-p2",
          namespace: "prod",
          uid: "pod-2",
          ownerReferences: [
            { apiVersion: "apps/v1", kind: "ReplicaSet", name: "other-xyz", uid: "rs-foreign" },
          ],
        },
      },
    },
  ],
}

describe("RelatedResourcesCard Deployment pods", () => {
  beforeEach(() => mockedTable.mockReset())

  const deployment: K8sObject = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace: "prod", uid: "dep-1" },
    spec: { selector: { matchLabels: { app: "web" } } },
  }

  it("lists the Deployment's pods, owned by its ReplicaSets and no others", async () => {
    mockedTable
      .mockResolvedValueOnce({ table: rsWithUid, truncated: false })
      .mockResolvedValueOnce({ table: podsTable, truncated: false })

    const wrapper = mountFor(deployment)
    await flushPromises()

    // Two hops: ReplicaSets, then Pods narrowed by the same selector.
    expect(mockedTable).toHaveBeenNthCalledWith(
      1,
      { group: "apps", version: "v1", resource: "replicasets" },
      expect.objectContaining({ namespace: "prod", labelSelector: "app=web" }),
    )
    expect(mockedTable).toHaveBeenNthCalledWith(
      2,
      { group: "", version: "v1", resource: "pods" },
      expect.objectContaining({ namespace: "prod", labelSelector: "app=web" }),
    )

    expect(wrapper.text()).toContain("ReplicaSets (1)")
    expect(wrapper.text()).toContain("Pods (1)")
    expect(wrapper.text()).toContain("web-abc-p1")
    // A pod owned by a ReplicaSet outside this Deployment is excluded.
    expect(wrapper.text()).not.toContain("foreign-p2")
  })

  it("renders nothing when the Deployment owns no ReplicaSets", async () => {
    // The RS and Pod walks run concurrently, so both are issued even when the
    // Deployment owns no ReplicaSets; the empty rsUids set drops the pod group.
    mockedTable
      .mockResolvedValueOnce({ table: rsWithUid, truncated: false })
      .mockResolvedValueOnce({ table: podsTable, truncated: false })
    const orphan: K8sObject = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "web", namespace: "prod", uid: "nobody" },
      spec: { selector: { matchLabels: { app: "web" } } },
    }
    const wrapper = mountFor(orphan)
    await flushPromises()

    expect(wrapper.find("section").exists()).toBe(false)
  })
})

describe("RelatedResourcesCard Service pods", () => {
  beforeEach(() => mockedTable.mockReset())

  const service: K8sObject = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "web", namespace: "prod", uid: "svc-1" },
    spec: { selector: { app: "web", Tier: "Frontend" } },
  }

  // Label keys/values are case-sensitive, so the selector must not ride along
  // in the uppercased group title.
  it("shows the selector outside the uppercased group title", async () => {
    mockedTable.mockResolvedValue({ table: podsTable, truncated: false })
    const wrapper = mountFor(service)
    await flushPromises()

    const title = wrapper.findAll("span").find((s) => s.text().startsWith("Pods ("))
    expect(title).toBeDefined()
    expect(title!.classes()).toContain("uppercase")
    expect(title!.text()).not.toContain("app=web")

    const selector = wrapper.findAll("span").find((s) => s.text() === "· selector app=web,Tier=Frontend")
    expect(selector).toBeDefined()
    expect(selector!.classes()).not.toContain("uppercase")
    // Smaller than the title's text-xs.
    expect(selector!.classes()).toContain("text-[10px]")
  })
})
