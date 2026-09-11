import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, ref } from "vue"

import type { K8sObject } from "@/api/types"

const startSpy = vi.hoisted(() => vi.fn())
const truncated = vi.hoisted(() => ({ value: false }))
const reconnecting = vi.hoisted(() => ({ value: null as string | null }))
// The buffer and version counter of the stream last created, so a test can
// push lines and bump it the way a flush does — the composable appends in
// place and the counter is its only signal.
const held = vi.hoisted(() => ({
  lines: { value: [] as string[] },
  version: { value: 0 },
  running: { value: false },
}))
const fetchSpy = vi.hoisted(() => vi.fn())
const saveSpy = vi.hoisted(() => vi.fn())

vi.mock("@/composables/useLogsStream", () => ({
  MAX_LINES: 200000,
  useLogsStream: () => {
    const lines = ref<string[]>([])
    const linesVersion = ref(0)
    const running = ref(false)
    held.lines = lines
    held.version = linesVersion
    held.running = running
    return {
      lines,
      linesVersion,
      dropped: ref(0),
      running,
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

// The tab registers a window keydown listener for Ctrl+F; a component left
// mounted by an earlier test would answer (and preventDefault) first.
enableAutoUnmount(afterEach)

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

/** A toolbar checkbox by label; the stream options live behind the Options button. */
async function checkbox(wrapper: ReturnType<typeof mount>, label: string) {
  const byLabel = () => wrapper.findAll("label").find((l) => l.text().trim() === label)
  if (byLabel() === undefined) {
    await wrapper.get("button[aria-haspopup]").trigger("click")
  }
  return byLabel()!.get("input[type=checkbox]")
}

function searchField(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('input[aria-label="Search log"]')
}

/** Types into the search field and lets the debounce run out. */
async function typeQuery(wrapper: ReturnType<typeof mount>, query: string): Promise<void> {
  await searchField(wrapper).setValue(query)
  vi.advanceTimersByTime(200)
  await nextTick()
}

/** A keydown as the browser would dispatch it — cancelable, so preventDefault registers. */
function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
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
    const box = await checkbox(wrapper, "Wrap")
    await box.setValue(true)

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
    const follow = await checkbox(wrapper, "Follow")

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

describe("PodLogsTab search", () => {
  beforeEach(() => {
    startSpy.mockClear()
    truncated.value = false
    reconnecting.value = null
    // Only the timers: `flushPromises` waits on setImmediate and must stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function mountWithLines(lines: string[]) {
    const wrapper = mount(PodLogsTab, {
      props: { object: pod("u1", "pod-a", "app") },
      attachTo: document.body,
    })
    await nextTick()
    for (const line of lines) held.lines.value.push(line)
    held.version.value++
    await nextTick()
    return wrapper
  }

  it("counts matches and walks them with Enter and Shift+Enter", async () => {
    const wrapper = await mountWithLines(["error one", "fine", "error two"])
    await typeQuery(wrapper, "error")
    expect(wrapper.text()).toContain("2 matches")
    const viewer = wrapper.findComponent({ name: "LogViewer" })
    expect(viewer.props("matches")).toEqual([0, 2])
    expect(viewer.props("activeMatch")).toBeNull()

    const field = searchField(wrapper)
    await field.trigger("keydown", { key: "Enter" })
    expect(wrapper.text()).toContain("1 / 2")
    await field.trigger("keydown", { key: "Enter" })
    expect(wrapper.text()).toContain("2 / 2")
    await field.trigger("keydown", { key: "Enter", shiftKey: true })
    expect(wrapper.text()).toContain("1 / 2")
    expect(viewer.props("activeMatch")).toBe(0)
    expect(viewer.props("jumpSeq")).toBe(3)
  })

  it("says so when nothing matches", async () => {
    const wrapper = await mountWithLines(["fine"])
    await typeQuery(wrapper, "error")
    expect(wrapper.text()).toContain("No matches")
    expect(wrapper.get('button[aria-label="Next match"]').attributes("disabled")).toBeDefined()
  })

  it("clears the query on Escape and prevents the default", async () => {
    const wrapper = await mountWithLines(["error"])
    await typeQuery(wrapper, "error")
    await searchField(wrapper).trigger("keydown", { key: "Enter" })
    expect(wrapper.text()).toContain("1 / 1")

    // A live Escape must not also reach AppShell's drawer handler, which
    // keys on defaultPrevented.
    const e = keydown({ key: "Escape" })
    searchField(wrapper).element.dispatchEvent(e)
    await nextTick()
    expect(e.defaultPrevented).toBe(true)
    expect((searchField(wrapper).element as HTMLInputElement).value).toBe("")
    vi.advanceTimersByTime(200)
    await nextTick()
    expect(wrapper.findComponent({ name: "LogViewer" }).props("matches")).toEqual([])
    expect(wrapper.text()).not.toContain("1 / 1")
  })

  it("intercepts Ctrl/Cmd+F while mounted and focuses the field", async () => {
    const wrapper = await mountWithLines(["error"])
    // By physical key: e.key is "а" on a Russian layout and "F" under
    // CapsLock, and the browser's own Find is bound the same way.
    const e = keydown({ key: "а", code: "KeyF", ctrlKey: true })
    window.dispatchEvent(e)
    await nextTick()
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(searchField(wrapper).element)

    // Not with Shift or Alt, which are other browser shortcuts.
    const shifted = keydown({ key: "F", code: "KeyF", ctrlKey: true, shiftKey: true })
    window.dispatchEvent(shifted)
    expect(shifted.defaultPrevented).toBe(false)

    wrapper.unmount()
    // Gone with the tab: the listener must not outlive the mount.
    const after = keydown({ key: "f", code: "KeyF", metaKey: true })
    window.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })

  it("filters only once a query is set, without restarting the stream", async () => {
    const wrapper = await mountWithLines(["error", "fine"])
    const viewer = wrapper.findComponent({ name: "LogViewer" })
    startSpy.mockClear()
    await (await checkbox(wrapper, "Filter")).setValue(true)
    // Filter with nothing to filter by would render an empty log.
    expect(viewer.props("filter")).toBe(false)

    await typeQuery(wrapper, "error")
    expect(viewer.props("filter")).toBe(true)
    expect(viewer.props("query")?.source).toBe("error")
    expect(startSpy).not.toHaveBeenCalled()
  })

  it("states that the follow scroll is paused while a match is selected", async () => {
    const wrapper = await mountWithLines(["error"])
    // The mock hands out a fresh `running` per stream, so only after mount.
    held.running.value = true
    await nextTick()
    expect(wrapper.text()).toContain("● streaming")
    expect(wrapper.text()).not.toContain("scroll paused")
    await typeQuery(wrapper, "error")
    await searchField(wrapper).trigger("keydown", { key: "Enter" })
    expect(wrapper.text()).toContain("● streaming (scroll paused)")
    held.running.value = false
  })
})
