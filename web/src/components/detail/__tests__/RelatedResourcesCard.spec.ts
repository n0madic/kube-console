import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { shallowRef } from "vue"

vi.mock("@/api/k8s", () => ({ listAllAsTable: vi.fn() }))

import { listAllAsTable } from "@/api/k8s"
import type { OwnedPods } from "@/api/ownedPods"
import type { K8sObject, K8sTable } from "@/api/types"
import RelatedResourcesCard from "@/components/detail/RelatedResourcesCard.vue"
import { OWNED_PODS_KEY, type OwnedPodsState } from "@/composables/useOwnedPods"

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
      object: { metadata: { name: "web-abc", namespace: "prod", uid: "rs-1" } },
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
      object: { metadata: { name: "web-abc-p1", namespace: "prod", uid: "pod-1" } },
    },
  ],
}

const jobsTable: K8sTable = {
  kind: "Table",
  columnDefinitions: [
    { name: "Name", type: "string" },
    { name: "Completions", type: "string" },
    { name: "Age", type: "string" },
  ],
  rows: [
    {
      cells: ["backup-1", "1/1", "1h"],
      object: {
        metadata: {
          name: "backup-1",
          namespace: "prod",
          ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: "backup", uid: "cj-1" }],
        },
      },
    },
    {
      cells: ["other-1", "1/1", "1h"],
      object: {
        metadata: {
          name: "other-1",
          namespace: "prod",
          ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: "other", uid: "cj-2" }],
        },
      },
    },
  ],
}

const deployment: K8sObject = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "prod", uid: "dep-1" },
  spec: { selector: { matchLabels: { app: "web" } } },
}

const stubs = { RouterLink: { props: ["to"], template: "<a><slot /></a>" } }

function mountFor(object: K8sObject) {
  return mount(RelatedResourcesCard, { props: { object }, global: { stubs } })
}

/** Mounted under the detail page: the pod-owner groups arrive by injection. */
function mountWith(object: K8sObject, state: OwnedPodsState) {
  const injected = shallowRef(state)
  const wrapper = mount(RelatedResourcesCard, {
    props: { object },
    global: { stubs, provide: { [OWNED_PODS_KEY as symbol]: injected } },
  })
  return { wrapper, injected }
}

function resolved(result: OwnedPods | null): OwnedPodsState {
  return { loading: false, error: null, result }
}

describe("RelatedResourcesCard injected pod-owner groups", () => {
  beforeEach(() => {
    mockedTable.mockReset()
  })

  it("renders a Deployment's ReplicaSets and Pods from the injected result", async () => {
    const { wrapper } = mountWith(
      deployment,
      resolved({ pods: podsTable, truncated: false, replicaSets: { table: rsTable, truncated: false } }),
    )
    await flushPromises()

    // Nothing walked by the card itself: the page resolved these.
    expect(mockedTable).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain("ReplicaSets (1)")
    expect(wrapper.text()).toContain("Pods (1)")
    expect(wrapper.text()).toContain("web-abc")
    expect(wrapper.text()).toContain("web-abc-p1")
    // Server priority-0 columns, no Namespace (same as parent), no Name column.
    const headers = wrapper.findAll("table").map((t) => t.findAll("th").map((th) => th.text()))
    expect(headers[0]).toEqual(["Name", "Desired", "Current", "Ready", "Age"])
    expect(headers[1]).toEqual(["Name", "Ready", "Status", "Restarts", "Age"])
    expect(headers.flat()).not.toContain("Namespace")
    // Name link + one cell per selected column, nothing extra in front: the
    // card leaves ResourceMiniTable's show-namespace unbound on this path too.
    const tables = wrapper.findAll("table")
    expect(tables[1]!.findAll("tbody tr")).toHaveLength(1)
    expect(tables[1]!.findAll("tbody td")).toHaveLength(headers[1]!.length)
    expect(tables[1]!.find("tbody td").text()).toBe("web-abc-p1")
  })

  it("marks a partial scan and links to the list", async () => {
    const { wrapper } = mountWith(deployment, resolved({ pods: podsTable, truncated: true }))
    await flushPromises()
    expect(wrapper.text()).toContain("Pods (partial scan)")
    expect(wrapper.text()).toContain("more…")
  })

  it("renders nothing when the result holds no rows", async () => {
    const { wrapper } = mountWith(
      deployment,
      resolved({
        pods: { ...podsTable, rows: [] },
        truncated: false,
        replicaSets: { table: { ...rsTable, rows: [] }, truncated: false },
      }),
    )
    await flushPromises()
    expect(wrapper.find("section").exists()).toBe(false)
  })

  // Without a provider (mounted outside the detail page) there are no owner
  // groups at all — never a fallback walk of the card's own.
  it("renders nothing for a pod owner without a provider", async () => {
    const wrapper = mountFor(deployment)
    await flushPromises()
    expect(mockedTable).not.toHaveBeenCalled()
    expect(wrapper.find("section").exists()).toBe(false)
  })

  it("shows Loading while the injected resolution runs, then the tables", async () => {
    const { wrapper, injected } = mountWith(deployment, { loading: true, error: null, result: null })
    await flushPromises()
    expect(wrapper.text()).toContain("Loading...")

    injected.value = resolved({ pods: podsTable, truncated: false })
    await flushPromises()
    expect(wrapper.text()).not.toContain("Loading...")
    expect(wrapper.text()).toContain("Pods (1)")
  })

  it("shows the injected error", async () => {
    const { wrapper } = mountWith(deployment, { loading: false, error: "forbidden", result: null })
    await flushPromises()
    expect(wrapper.text()).toContain("Cannot load related resources: forbidden")
  })

  // Label keys/values are case-sensitive, so the selector must not ride along
  // in the uppercased group title.
  it("shows a Service's selector outside the uppercased group title", async () => {
    const service: K8sObject = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "web", namespace: "prod", uid: "svc-1" },
      spec: { selector: { app: "web", Tier: "Frontend" } },
    }
    const { wrapper } = mountWith(
      service,
      resolved({ pods: podsTable, truncated: false, selector: "app=web,Tier=Frontend" }),
    )
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

describe("RelatedResourcesCard own children (CronJob → Jobs)", () => {
  beforeEach(() => {
    mockedTable.mockReset()
  })

  const cronJob: K8sObject = {
    apiVersion: "batch/v1",
    kind: "CronJob",
    metadata: { name: "backup", namespace: "prod", uid: "cj-1" },
    spec: { schedule: "0 * * * *" },
  }

  it("walks the namespace's Jobs and keeps the ones owned by this CronJob", async () => {
    mockedTable.mockResolvedValue({ table: jobsTable, truncated: false })
    const wrapper = mountFor(cronJob)
    await flushPromises()

    // Jobs carry no selector guarantee: a bounded full walk, no labelSelector.
    expect(mockedTable).toHaveBeenCalledWith(
      { group: "batch", version: "v1", resource: "jobs" },
      expect.objectContaining({ namespace: "prod", maxPages: 6 }),
    )
    expect(mockedTable.mock.calls[0]?.[1]).not.toHaveProperty("labelSelector")
    expect(wrapper.text()).toContain("Jobs (1)")
    expect(wrapper.text()).toContain("backup-1")
    expect(wrapper.text()).not.toContain("other-1")
    // Name link + one cell per selected column, nothing extra in front.
    expect(wrapper.findAll("tbody tr")).toHaveLength(1)
    expect(wrapper.find("tbody td").text()).toBe("backup-1")
  })

  // Regression: keyed on metadata.uid, a manual run followed by the detail
  // page's refresh left the children table showing the pre-action state.
  it("re-scans children when the page hands over a refreshed object", async () => {
    mockedTable.mockResolvedValue({ table: jobsTable, truncated: false })
    const wrapper = mountFor(cronJob)
    await flushPromises()
    expect(mockedTable).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ object: { ...cronJob, spec: { schedule: "5 * * * *" } } })
    await flushPromises()
    expect(mockedTable).toHaveBeenCalledTimes(2)
  })

  it("renders nothing when no job is owned by this object", async () => {
    mockedTable.mockResolvedValue({ table: jobsTable, truncated: false })
    const wrapper = mountFor({ ...cronJob, metadata: { ...cronJob.metadata, uid: "nobody" } })
    await flushPromises()
    expect(wrapper.find("section").exists()).toBe(false)
  })

  it("renders its own load error", async () => {
    mockedTable.mockRejectedValue(new Error("network down"))
    const wrapper = mountFor(cronJob)
    await flushPromises()
    expect(wrapper.text()).toContain("Cannot load related resources: Error: network down")
  })
})

describe("RelatedResourcesCard Ingress backends", () => {
  beforeEach(() => {
    mockedTable.mockReset()
  })

  it("links backend services by name without fetching them", async () => {
    const ingress: K8sObject = {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: { name: "web", namespace: "prod", uid: "ing-1" },
      spec: {
        defaultBackend: { service: { name: "fallback" } },
        rules: [
          { http: { paths: [{ backend: { service: { name: "web" } } }, { backend: { service: { name: "api" } } }] } },
          { http: { paths: [{ backend: { service: { name: "web" } } }] } },
        ],
      },
    }
    const wrapper = mountFor(ingress)
    await flushPromises()

    expect(mockedTable).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain("Backend Services")
    expect(wrapper.findAll("a").map((a) => a.text())).toEqual(["fallback", "web", "api"])
  })
})
