import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, ref } from "vue"

import type { K8sObject } from "@/api/types"

const startSpy = vi.hoisted(() => vi.fn())
const truncated = vi.hoisted(() => ({ value: false }))
const fetchSpy = vi.hoisted(() => vi.fn())
const saveSpy = vi.hoisted(() => vi.fn())

vi.mock("@/composables/useLogsStream", () => ({
  MAX_LINES: 200000,
  useLogsStream: () => ({
    lines: ref<string[]>([]),
    running: ref(false),
    error: ref<string | null>(null),
    truncated,
    start: startSpy,
    stop: vi.fn(),
  }),
}))

vi.mock("@/api/http", async () => {
  const actual = await vi.importActual<typeof import("@/api/http")>("@/api/http")
  return { ...actual, apiFetch: fetchSpy }
})

vi.mock("@/utils/download", () => ({ saveBlob: saveSpy }))

import PodLogsTab from "@/components/pod/PodLogsTab.vue"

function pod(uid: string, name: string, container: string): K8sObject {
  return {
    kind: "Pod",
    metadata: { uid, name, namespace: "default" },
    spec: { containers: [{ name: container }] },
  }
}

describe("PodLogsTab", () => {
  beforeEach(() => {
    startSpy.mockClear()
    fetchSpy.mockReset()
    saveSpy.mockReset()
    truncated.value = false
  })

  it("restarts the log stream for the new pod on an in-place pod change", async () => {
    const wrapper = mount(PodLogsTab, { props: { object: pod("u1", "pod-a", "app") } })
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(startSpy.mock.calls[0]?.[0]).toContain("pod-a")

    startSpy.mockClear()
    await wrapper.setProps({ object: pod("u2", "pod-b", "app") })

    expect(startSpy).toHaveBeenCalled()
    expect(startSpy.mock.calls.at(-1)?.[0]).toContain("pod-b")
    expect(startSpy.mock.calls.at(-1)?.[0]).not.toContain("pod-a")
  })

  it("toggles wrap without restarting the stream", async () => {
    const wrapper = mount(PodLogsTab, { props: { object: pod("u1", "pod-a", "app") } })
    await nextTick()
    expect(wrapper.findComponent({ name: "LogViewer" }).props("wrap")).toBe(false)

    startSpy.mockClear()
    const box = wrapper.findAll("input[type=checkbox]").at(-1)
    await box?.setValue(true)

    expect(wrapper.findComponent({ name: "LogViewer" }).props("wrap")).toBe(true)
    expect(startSpy).not.toHaveBeenCalled()
  })

  // The log endpoint has no pagination, so reading from the container's start
  // means requesting it without tailLines at all.
  it("drops tailLines from the request when Tail is All", async () => {
    const wrapper = mount(PodLogsTab, { props: { object: pod("u1", "pod-a", "app") } })
    await nextTick()
    expect(startSpy.mock.calls.at(-1)?.[0]).toContain("tailLines=500")

    await wrapper.findAll("select")[1]?.setValue("all")

    const url = startSpy.mock.calls.at(-1)?.[0] as string
    expect(url).not.toContain("tailLines")
    expect(url).toContain("follow=true")
  })

  it("downloads the whole log without following it", async () => {
    fetchSpy.mockResolvedValue({ blob: () => Promise.resolve(new Blob(["log"])) })
    const wrapper = mount(PodLogsTab, { props: { object: pod("u1", "pod-a", "app") } })
    await nextTick()

    // Icon-only button: the accessible name is the only stable handle on it.
    await wrapper.get('button[aria-label="Download the full log"]').trigger("click")
    await flushPromises()

    const url = fetchSpy.mock.calls[0]?.[0] as string
    expect(url).toContain("/pods/pod-a/log")
    expect(url).toContain("container=app")
    expect(url).not.toContain("tailLines")
    expect(url).not.toContain("follow")
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy.mock.calls[0]?.[1]).toBe("pod-a_app.log")
  })

  it("warns when the viewer dropped the start of the log", async () => {
    truncated.value = true
    const wrapper = mount(PodLogsTab, { props: { object: pod("u1", "pod-a", "app") } })
    await nextTick()

    expect(wrapper.text()).toContain("The start of the log was dropped")
  })
})
