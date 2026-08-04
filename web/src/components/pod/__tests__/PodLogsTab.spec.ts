import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, ref } from "vue"

import type { K8sObject } from "@/api/types"

const startSpy = vi.hoisted(() => vi.fn())
const truncated = vi.hoisted(() => ({ value: false }))
const reconnecting = vi.hoisted(() => ({ value: null as string | null }))
// The version counter of the stream last created, so a test can bump it the way
// a flush does — the composable appends in place and this is its only signal.
const held = vi.hoisted(() => ({ version: { value: 0 } }))
const fetchSpy = vi.hoisted(() => vi.fn())
const saveSpy = vi.hoisted(() => vi.fn())

vi.mock("@/composables/useLogsStream", () => ({
  MAX_LINES: 200000,
  useLogsStream: () => {
    const linesVersion = ref(0)
    held.version = linesVersion
    return {
      lines: ref<string[]>([]),
      linesVersion,
      running: ref(false),
      error: ref<string | null>(null),
      reconnecting,
      truncated,
      start: startSpy,
      stop: vi.fn(),
    }
  },
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

// By label, not by index: a single-container pod renders no container select
// at all, so the Tail one is not at a fixed position in the toolbar.
function tailSelect(wrapper: ReturnType<typeof mount>) {
  return wrapper
    .findAll("label")
    .find((l) => l.text().startsWith("Tail"))!
    .get("select")
}

describe("PodLogsTab", () => {
  beforeEach(() => {
    startSpy.mockClear()
    fetchSpy.mockReset()
    saveSpy.mockReset()
    truncated.value = false
    reconnecting.value = null
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

    await tailSelect(wrapper).setValue("all")

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

  it("hands the stream's version counter to the viewer", async () => {
    const wrapper = mount(PodLogsTab, { props: { object: pod("u1", "pod-a", "app") } })
    await nextTick()
    const viewer = wrapper.findComponent({ name: "LogViewer" })
    expect(viewer.props("version")).toBe(0)

    // Without this wiring the viewer never learns that the shared line array
    // grew, since the stream mutates it instead of replacing it.
    held.version.value++
    await nextTick()
    expect(viewer.props("version")).toBe(1)
  })

  // A followed stream that drops is reconnected, not reported: the endpoint has
  // no cursor, so the resume window is the seconds since the last line arrived.
  it("resumes a dropped follow stream from the last line instead of the tail", async () => {
    mount(PodLogsTab, { props: { object: pod("u1", "pod-a", "app") } })
    await nextTick()
    const started = startSpy.mock.calls.at(-1)
    const resume = (started?.[1] as { resume?: (s: number | null) => string | null }).resume!

    const url = resume(42)
    expect(url).toContain("/pods/pod-a/log")
    expect(url).toContain("container=app")
    expect(url).toContain("sinceSeconds=42")
    expect(url).toContain("follow=true")
    // The buffer already holds everything up to the window, so a tail on top of
    // it would only re-deliver lines that are on screen.
    expect(url).not.toContain("tailLines")
    // Nothing received yet: the original request still describes what is wanted.
    expect(resume(null)).toBe(started?.[0])
  })

  it("does not reconnect a stream that is not followed", async () => {
    const wrapper = mount(PodLogsTab, { props: { object: pod("u1", "pod-a", "app") } })
    await nextTick()
    const follow = wrapper
      .findAll("label")
      .find((l) => l.text().includes("Follow"))!
      .get("input[type=checkbox]")

    await follow.setValue(false)

    const opts = startSpy.mock.calls.at(-1)?.[1] as { resume?: unknown }
    expect(opts.resume).toBeUndefined()
  })

  it("states a reconnect in place rather than as a failure", async () => {
    reconnecting.value = "Log stream failed."
    const wrapper = mount(PodLogsTab, { props: { object: pod("u1", "pod-a", "app") } })
    await nextTick()

    expect(wrapper.text()).toContain("Log stream failed. Reconnecting…")
    expect(wrapper.text()).toContain("● reconnecting")
  })

  it("warns when the viewer dropped the start of the log", async () => {
    truncated.value = true
    const wrapper = mount(PodLogsTab, { props: { object: pod("u1", "pod-a", "app") } })
    await nextTick()

    expect(wrapper.text()).toContain("The start of the log was dropped")
  })
})
