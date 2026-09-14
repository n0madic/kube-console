import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

import { ApiError } from "@/api/http"
import type { OwnedPods } from "@/api/ownedPods"
import type { K8sObject } from "@/api/types"

const startSpy = vi.hoisted(() => vi.fn())

vi.mock("@/composables/useLogsStream", () => ({
  MAX_LINES: 200000,
  useLogsStream: () => ({
    lines: ref<string[]>([]),
    linesVersion: ref(0),
    dropped: ref(0),
    running: ref(false),
    error: ref<string | null>(null),
    reconnecting: ref<string | null>(null),
    truncated: ref(false),
    start: startSpy,
    stop: vi.fn(),
  }),
}))

// Only getObject: PodLogsTab imports logsUrl from the same module.
vi.mock("@/api/k8s", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/k8s")>()
  return { ...actual, getObject: vi.fn() }
})

import { getObject } from "@/api/k8s"
import PodLogsTab from "@/components/pod/PodLogsTab.vue"
import WorkloadLogsTab from "@/components/pod/WorkloadLogsTab.vue"
import WorkloadPodSelect from "@/components/pod/WorkloadPodSelect.vue"

const mockedGet = vi.mocked(getObject)

// PodLogsTab registers a window keydown listener for Ctrl+F.
enableAutoUnmount(afterEach)

const DEPLOYMENT: K8sObject = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "prod", uid: "dep-1" },
}

function pod(name: string, uid: string): K8sObject {
  return {
    kind: "Pod",
    metadata: { uid, name, namespace: "prod" },
    spec: { containers: [{ name: "app" }] },
  }
}

interface RowSpec {
  name: string
  status: string
  created: string
}

function ownedPods(rows: RowSpec[], truncated = false): OwnedPods {
  return {
    pods: {
      kind: "Table",
      columnDefinitions: [
        { name: "Name", type: "string" },
        { name: "Status", type: "string" },
      ],
      rows: rows.map((r) => ({
        cells: [r.name, r.status],
        object: {
          metadata: { name: r.name, uid: `uid-${r.name}`, namespace: "prod", creationTimestamp: r.created },
        },
      })),
    },
    truncated,
  }
}

const TWO_PODS = ownedPods([
  { name: "web-old", status: "Running", created: "2026-01-01T00:00:00Z" },
  { name: "web-new", status: "Running", created: "2026-02-01T00:00:00Z" },
  { name: "web-crash", status: "CrashLoopBackOff", created: "2026-03-01T00:00:00Z" },
])

function mountTab(owned: OwnedPods = TWO_PODS) {
  return mount(WorkloadLogsTab, { props: { object: DEPLOYMENT, ownedPods: owned } })
}

function podSelect(wrapper: ReturnType<typeof mountTab>) {
  return wrapper.getComponent(WorkloadPodSelect).get("select")
}

describe("WorkloadLogsTab", () => {
  beforeEach(() => {
    mockedGet.mockReset()
    mockedGet.mockImplementation(async (_ref, _ns, name) => pod(name, `live-${name}`))
    startSpy.mockClear()
  })

  it("preselects the newest Running pod, fetches it and streams it", async () => {
    const wrapper = mountTab()
    // The picker is on screen before the GET answers.
    expect(podSelect(wrapper).element.value).toBe("web-new")
    expect(wrapper.findComponent(PodLogsTab).exists()).toBe(false)
    expect(wrapper.text()).toContain("Loading…")

    await flushPromises()
    expect(mockedGet).toHaveBeenCalledTimes(1)
    expect(mockedGet).toHaveBeenCalledWith(
      { group: "", version: "v1", resource: "pods" },
      "prod",
      "web-new",
    )
    const logs = wrapper.getComponent(PodLogsTab)
    expect((logs.props("object") as K8sObject).metadata?.uid).toBe("live-web-new")
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(startSpy.mock.calls[0]?.[0]).toContain("web-new")
    // The picker moved into the log toolbar, ahead of the Container one.
    const labels = logs.findAll("label").map((l) => l.text())
    expect(labels[0]).toMatch(/^Pod/)
    expect(labels[1]).toMatch(/^Container/)
    expect(wrapper.text()).not.toContain("Loading…")
  })

  it("fetches the picked pod and hands it to the log tab", async () => {
    const wrapper = mountTab()
    await flushPromises()

    await podSelect(wrapper).setValue("web-crash")
    await flushPromises()

    expect(mockedGet).toHaveBeenCalledTimes(2)
    expect(mockedGet).toHaveBeenLastCalledWith(expect.anything(), "prod", "web-crash")
    const logs = wrapper.getComponent(PodLogsTab)
    expect((logs.props("object") as K8sObject).metadata?.uid).toBe("live-web-crash")
    expect(startSpy.mock.calls.at(-1)?.[0]).toContain("web-crash")
  })

  it("keeps the pick by name across a new pod list", async () => {
    const wrapper = mountTab()
    await flushPromises()
    await podSelect(wrapper).setValue("web-old")
    await flushPromises()
    expect(mockedGet).toHaveBeenCalledTimes(2)

    await wrapper.setProps({
      ownedPods: ownedPods([
        { name: "web-old", status: "Running", created: "2026-01-01T00:00:00Z" },
        { name: "web-newer", status: "Running", created: "2026-04-01T00:00:00Z" },
      ]),
    })
    await flushPromises()

    expect(podSelect(wrapper).element.value).toBe("web-old")
    // Re-fetched once, not twice: a kept name still needs the fresh object (a
    // StatefulSet pod keeps its name when recreated, and PodLogsTab restarts
    // on the uid), and the selection watch must not double it.
    expect(mockedGet).toHaveBeenCalledTimes(3)
    expect(mockedGet).toHaveBeenLastCalledWith(expect.anything(), "prod", "web-old")
  })

  it("falls back to the default when the picked pod is gone", async () => {
    const wrapper = mountTab()
    await flushPromises()
    await podSelect(wrapper).setValue("web-old")
    await flushPromises()

    await wrapper.setProps({
      ownedPods: ownedPods([
        { name: "web-new", status: "Running", created: "2026-02-01T00:00:00Z" },
        { name: "web-newer", status: "Pending", created: "2026-04-01T00:00:00Z" },
      ]),
    })
    await flushPromises()

    expect(podSelect(wrapper).element.value).toBe("web-new")
    expect(mockedGet).toHaveBeenCalledTimes(3)
    expect(mockedGet).toHaveBeenLastCalledWith(expect.anything(), "prod", "web-new")
  })

  it("restarts the stream when a kept name resolves to a new uid", async () => {
    const wrapper = mountTab()
    await flushPromises()
    expect(startSpy).toHaveBeenCalledTimes(1)

    mockedGet.mockImplementation(async (_ref, _ns, name) => pod(name, `recreated-${name}`))
    await wrapper.setProps({ ownedPods: { ...TWO_PODS } })
    await flushPromises()

    const logs = wrapper.getComponent(PodLogsTab)
    expect((logs.props("object") as K8sObject).metadata?.uid).toBe("recreated-web-new")
    expect(startSpy).toHaveBeenCalledTimes(2)
  })

  it("keeps the streaming pod mounted when a pick fails to load", async () => {
    const wrapper = mountTab()
    await flushPromises()

    mockedGet.mockRejectedValueOnce(new ApiError(404, 'pods "web-crash" not found'))
    await podSelect(wrapper).setValue("web-crash")
    await flushPromises()

    const logs = wrapper.getComponent(PodLogsTab)
    expect((logs.props("object") as K8sObject).metadata?.uid).toBe("live-web-new")
    expect(wrapper.text()).toContain('Cannot load pod web-crash: pods "web-crash" not found')
    expect(startSpy).toHaveBeenCalledTimes(1)

    // The next successful pick clears the error.
    await podSelect(wrapper).setValue("web-old")
    await flushPromises()
    expect(wrapper.text()).not.toContain("Cannot load pod")
  })

  it("shows the error with the picker, and no log tab, when the first load fails", async () => {
    mockedGet.mockRejectedValueOnce(new ApiError(403, "forbidden"))
    const wrapper = mountTab()
    await flushPromises()

    expect(wrapper.findComponent(PodLogsTab).exists()).toBe(false)
    expect(podSelect(wrapper).element.value).toBe("web-new")
    expect(wrapper.text()).toContain("Cannot load pod web-new: forbidden")
    expect(wrapper.text()).not.toContain("Loading…")
  })

  it("discards a stale pod response that lands after a newer pick's", async () => {
    const resolvers: Record<string, (p: K8sObject) => void> = {}
    mockedGet.mockImplementation(
      (_ref, _ns, name) =>
        new Promise<K8sObject>((res) => {
          resolvers[name] = res
        }),
    )
    const wrapper = mountTab()
    await flushPromises()
    await podSelect(wrapper).setValue("web-crash")
    await flushPromises()

    resolvers["web-crash"]?.(pod("web-crash", "c"))
    await flushPromises()
    resolvers["web-new"]?.(pod("web-new", "n"))
    await flushPromises()

    const logs = wrapper.getComponent(PodLogsTab)
    expect((logs.props("object") as K8sObject).metadata?.uid).toBe("c")
  })

  it("passes the truncation marker through to the picker", async () => {
    const wrapper = mountTab(ownedPods(
      [{ name: "web-1", status: "Running", created: "2026-01-01T00:00:00Z" }],
      true,
    ))
    await flushPromises()
    expect(wrapper.find('option[value="__truncated__"]').exists()).toBe(true)
  })
})
