import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"

import type { K8sObject } from "@/api/types"
import { AUTO_PRESET, COMMAND_SUGGESTIONS } from "@/utils/shellPresets"

const stopSpy = vi.hoisted(() => vi.fn())
const startSpy = vi.hoisted(() =>
  vi.fn(async (_target: { namespace: string; pod: string; container: string; command: string[] }) => {}),
)
// Handle to the refs of the most recently created session so tests can drive
// the errorMessage watch (the missing-shell hint).
const lastSession = vi.hoisted(() => ({
  errorMessage: null as { value: string | null } | null,
}))

vi.mock("@/composables/useExecSession", async () => {
  const { ref } = await import("vue")
  return {
    useExecSession: () => {
      const errorMessage = ref<string | null>(null)
      lastSession.errorMessage = errorMessage
      return {
        status: ref("idle"),
        errorMessage,
        start: startSpy,
        stop: stopSpy,
        sendInput: vi.fn(),
        sendResize: vi.fn(),
      }
    },
  }
})

import PodTerminalTab from "@/components/pod/PodTerminalTab.vue"

// TerminalView pulls xterm; a stub exposing the imperative API the tab uses
// keeps the test in jsdom.
const termSpies = { fitNow: vi.fn(), focus: vi.fn(), write: vi.fn() }
const TerminalStub = defineComponent({
  name: "TerminalView",
  setup(_, { expose }) {
    expose({
      fitNow: termSpies.fitNow,
      focus: termSpies.focus,
      write: termSpies.write,
      size: () => ({ cols: 80, rows: 24 }),
    })
    return () => h("div")
  },
})

function pod(
  uid: string,
  name: string,
  containers: string[],
  extra: { spec?: Record<string, unknown>; annotations?: Record<string, string> } = {},
): K8sObject {
  return {
    kind: "Pod",
    metadata: { uid, name, namespace: "default", annotations: extra.annotations },
    spec: { containers: containers.map((name) => ({ name })), ...extra.spec },
  }
}

function mountTab(object: K8sObject, active = true) {
  return mount(PodTerminalTab, {
    props: { object, active },
    global: { stubs: { TerminalView: TerminalStub } },
  })
}

type Wrapper = ReturnType<typeof mountTab>

// The combobox's popup toggle is a button too, and it comes first in the DOM.
const startButton = (wrapper: Wrapper) =>
  wrapper.findAll("button").find((b) => b.text().includes("Start terminal"))!
const commandInput = (wrapper: Wrapper) => wrapper.get("input")

const NO_SHELL = 'exec failed: executable file not found in $PATH: "sh"'
const AUTO_ARGV = AUTO_PRESET.argv

describe("PodTerminalTab", () => {
  beforeEach(() => {
    stopSpy.mockClear()
    startSpy.mockClear()
    Object.values(termSpies).forEach((spy) => spy.mockClear())
    lastSession.errorMessage = null
  })

  // The tab is hidden, not unmounted, when another tab of the pod page is
  // shown, so the running shell survives the round trip. xterm cannot measure
  // itself while hidden, hence the refit on the way back.
  it("keeps the session and refits when the tab is shown again", async () => {
    const wrapper = mountTab(pod("u1", "pod-a", ["app"]))
    await startButton(wrapper).trigger("click")
    await flushPromises()
    expect(startSpy).toHaveBeenCalledTimes(1)
    termSpies.fitNow.mockClear()
    termSpies.focus.mockClear()

    await wrapper.setProps({ active: false })
    expect(stopSpy).not.toHaveBeenCalled()

    await wrapper.setProps({ active: true })
    await flushPromises()
    expect(termSpies.fitNow).toHaveBeenCalled()
    expect(termSpies.focus).toHaveBeenCalled()
    // Same session: no reconnect, so the shell keeps its scrollback and state.
    expect(startSpy).toHaveBeenCalledTimes(1)
  })

  it("tears down the exec session on an in-place pod change", async () => {
    const wrapper = mountTab(pod("u1", "pod-a", ["app"]))

    // Switching to a different pod must stop the old session so the terminal
    // is never left bound to the previous pod.
    await wrapper.setProps({ object: pod("u2", "pod-b", ["worker"]) })

    expect(stopSpy).toHaveBeenCalled()
  })

  // The alias is display only: the field reads "Auto" but the argv on the wire
  // is the full one-liner.
  it("shows the Auto alias while holding the whole command", () => {
    const wrapper = mountTab(pod("u1", "pod-a", ["app"]))

    expect(commandInput(wrapper).element.value).toBe("Auto")
    expect(commandInput(wrapper).attributes("title")).toBe(COMMAND_SUGGESTIONS[0]!.value)
  })

  // Auto resolves bash-or-sh inside the container, in one exec: the tab used to
  // connect with /bin/bash and reconnect with /bin/sh after the failure.
  it("starts the Auto command by default and never reconnects on failure", async () => {
    const wrapper = mountTab(pod("u1", "pod-a", ["app"]))
    await startButton(wrapper).trigger("click")
    await flushPromises()
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({ command: AUTO_ARGV, container: "app" })

    lastSession.errorMessage!.value = NO_SHELL
    await flushPromises()
    expect(startSpy).toHaveBeenCalledTimes(1)
  })

  // Both pickers describe an exec that is already running, so they are locked
  // for its lifetime — and that has to be visible, or the click that does
  // nothing looks like a bug rather than a lock.
  it("visibly locks both pickers while the session runs", async () => {
    const wrapper = mountTab(pod("u1", "pod-a", ["app"]))
    await startButton(wrapper).trigger("click")
    await flushPromises()

    expect(wrapper.get("select").attributes("disabled")).toBeDefined()
    expect(commandInput(wrapper).attributes("disabled")).toBeDefined()
    expect(wrapper.get("label").classes()).toContain("opacity-60")
    expect(commandInput(wrapper).element.parentElement!.className).toContain("opacity-60")
    // …and says what to do about it.
    expect(wrapper.get("label").attributes("title")).toContain("Disconnect first")
  })

  // Picking a suggestion only fills the field; the field is what runs, so a
  // preset is a starting point that can then be edited.
  it("runs a suggestion picked from the combobox", async () => {
    const wrapper = mountTab(pod("u1", "pod-a", ["app"]))
    const bashLogin = COMMAND_SUGGESTIONS.findIndex((s) => s.value === "/bin/bash -l")

    await wrapper.findAll("button")[0]!.trigger("click") // open the popup
    await wrapper.findAll("[role='option']")[bashLogin]!.trigger("click")
    expect(commandInput(wrapper).element.value).toBe("/bin/bash -l")

    await startButton(wrapper).trigger("click")
    await flushPromises()
    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({ command: ["/bin/bash", "-l"] })
  })

  // The field takes any argv, quoted the way `parseCommandLine` reads it —
  // there is no separate "custom" input to switch into any more.
  it("sends a typed command line as a quoted argv", async () => {
    const wrapper = mountTab(pod("u1", "pod-a", ["app"]))
    await commandInput(wrapper).setValue("/bin/sh -c 'echo hi; exec sh'")
    await startButton(wrapper).trigger("click")
    await flushPromises()

    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({
      command: ["/bin/sh", "-c", "echo hi; exec sh"],
    })
  })

  it("points at a debug container when even sh is missing", async () => {
    const wrapper = mountTab(pod("u1", "pod-a", ["app"]))
    await startButton(wrapper).trigger("click")
    await flushPromises()

    lastSession.errorMessage!.value = NO_SHELL
    await flushPromises()

    expect(wrapper.text()).toContain("kubectl debug -it -n default pod-a --image=busybox --target=app")
  })

  // A hand-picked shell that is missing is a different problem: other shells
  // may well be there, so the hint sends the user to Auto, not to kubectl.
  it("suggests Auto when a hand-picked shell is missing", async () => {
    const wrapper = mountTab(pod("u1", "pod-a", ["app"]))
    await commandInput(wrapper).setValue("/bin/zsh")
    await startButton(wrapper).trigger("click")
    await flushPromises()

    lastSession.errorMessage!.value = 'exec failed: executable file not found in $PATH: "/bin/zsh"'
    await flushPromises()

    expect(wrapper.text()).toContain("try the Auto command")
    expect(wrapper.text()).not.toContain("kubectl debug")
  })

  it("preselects the container named by the kubectl default-container annotation", async () => {
    const wrapper = mountTab(
      pod("u1", "pod-a", ["istio-proxy", "app"], {
        annotations: { "kubectl.kubernetes.io/default-container": "app" },
      }),
    )
    await startButton(wrapper).trigger("click")
    await flushPromises()

    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({ container: "app" })
  })
})
