import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"

vi.mock("@/api/http", async () => {
  const actual = await vi.importActual<typeof import("@/api/http")>("@/api/http")
  return { ...actual, apiJson: vi.fn() }
})

const findByKind = vi.fn()
vi.mock("@/composables/useDiscovery", () => ({
  useDiscovery: () => ({ findByKind }),
}))

import { apiJson } from "@/api/http"
import type { DiscoveryResource, K8sObjectList } from "@/api/types"
import RecentEventsCard from "@/components/events/RecentEventsCard.vue"
import { useAuthStore } from "@/stores/auth"
import { usePreferencesStore } from "@/stores/preferences"
import { useUiStore } from "@/stores/ui"

const mockedJson = vi.mocked(apiJson)

function eventList(names: string[]): K8sObjectList {
  return typedEvents(names.map((n) => ({ name: n, type: "Normal" })))
}

function typedEvents(entries: Array<{ name: string; type: string }>): K8sObjectList {
  return {
    items: entries.map(
      (e, i) =>
        ({
          metadata: {
            uid: e.name,
            namespace: "default",
            creationTimestamp: `2026-07-20T10:0${i}:00Z`,
          },
          type: e.type,
          reason: e.name,
          involvedObject: { kind: "Pod", name: e.name, apiVersion: "v1" },
        }) as unknown as K8sObjectList["items"][number],
    ),
  }
}

function mountCard() {
  return mount(RecentEventsCard, {
    global: {
      stubs: {
        RouterLink: { props: ["to"], template: "<a><slot /></a>" },
        BaseButton: { template: "<button><slot /></button>" },
      },
    },
  })
}

describe("RecentEventsCard", () => {
  beforeEach(() => {
    // Preferences (localStorage) and sessions (sessionStorage) outlive a pinia
    // reset, so a previous test's "Only warnings"/token would leak in.
    window.localStorage.clear()
    window.sessionStorage.clear()
    setActivePinia(createPinia())
    mockedJson.mockReset()
    findByKind.mockReset()
  })

  it("does not let a stale namespace load overwrite a newer one", async () => {
    const ui = useUiStore()
    let resolveFirst!: (v: K8sObjectList) => void
    let resolveSecond!: (v: K8sObjectList) => void
    mockedJson
      .mockReturnValueOnce(new Promise<K8sObjectList>((r) => (resolveFirst = r)) as Promise<unknown>)
      .mockReturnValueOnce(new Promise<K8sObjectList>((r) => (resolveSecond = r)) as Promise<unknown>)

    const wrapper = mountCard() // onMounted → load #1 (namespace "")
    ui.namespace = "prod"
    await nextTick() // watch(ui.namespace) → load #2

    // The newer (second) load resolves first, then the stale (first) one.
    resolveSecond(eventList(["new-evt"]))
    await flushPromises()
    resolveFirst(eventList(["stale-evt"]))
    await flushPromises()

    expect(wrapper.text()).toContain("new-evt")
    expect(wrapper.text()).not.toContain("stale-evt")
  })

  // Regression: items:null (Go nil-slice marshaling from a nonstandard
  // server) crashed into the error banner instead of the empty state.
  it("treats items:null as an empty list, not an error", async () => {
    // The namespace mirror survives in sessionStorage across tests.
    useUiStore().namespace = ""
    mockedJson.mockResolvedValue({ items: null } as unknown as K8sObjectList)
    const wrapper = mountCard()
    await flushPromises()

    expect(wrapper.text()).toContain("No recent events.")
    // The resourcePath-built URL must stay identical to the hand-rolled one.
    expect(mockedJson).toHaveBeenCalledWith(
      "/k8s/api/v1/events?limit=1000",
      expect.anything(),
    )
  })

  it("scopes the events URL to the selected namespace", async () => {
    const ui = useUiStore()
    ui.namespace = "prod"
    mockedJson.mockResolvedValue(eventList([]))
    mountCard()
    await flushPromises()

    expect(mockedJson).toHaveBeenCalledWith(
      "/k8s/api/v1/namespaces/prod/events?limit=1000",
      expect.anything(),
    )
  })

  it("links an event to its involved object when the kind is discoverable", async () => {
    const podEntry: DiscoveryResource = {
      id: "core/v1/pods",
      group: "",
      version: "v1",
      resource: "pods",
      kind: "Pod",
      namespaced: true,
      verbs: ["list"],
    }
    findByKind.mockReturnValue(podEntry)
    mockedJson.mockResolvedValue(eventList(["boom"]))

    const wrapper = mountCard()
    await flushPromises()

    const link = wrapper.find("a")
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain("Pod/boom")
    // One discovery lookup per row, not the three the template used to trigger.
    expect(findByKind).toHaveBeenCalledTimes(1)
  })

  it("filters to Warning events when 'Only warnings' is enabled", async () => {
    mockedJson.mockResolvedValue(
      typedEvents([
        { name: "normal-evt", type: "Normal" },
        { name: "warn-evt", type: "Warning" },
      ]),
    )
    const prefs = usePreferencesStore()
    const wrapper = mountCard()
    await flushPromises()

    // Default: both types visible.
    expect(wrapper.text()).toContain("normal-evt")
    expect(wrapper.text()).toContain("warn-evt")

    prefs.prefs.eventsOnlyWarnings = true
    await nextTick()

    expect(wrapper.text()).toContain("warn-evt")
    expect(wrapper.text()).not.toContain("normal-evt")
  })

  // Regression: only the namespace was watched, so switching clusters with the
  // same namespace selected left the previous cluster's events on screen.
  it("drops and refetches the events on a cluster context switch", async () => {
    const auth = useAuthStore()
    auth.setSession("alpha", "tok-alpha", null, false)
    mockedJson.mockResolvedValueOnce(eventList(["alpha-evt"]))
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.text()).toContain("alpha-evt")

    mockedJson.mockResolvedValueOnce(eventList(["beta-evt"]))
    auth.setSession("beta", "tok-beta", null, false)
    await flushPromises()

    expect(mockedJson).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain("beta-evt")
    expect(wrapper.text()).not.toContain("alpha-evt")
  })

  it("clears the events without refetching when the new context has no session", async () => {
    const auth = useAuthStore()
    auth.setSession("alpha", "tok-alpha", null, false)
    mockedJson.mockResolvedValueOnce(eventList(["alpha-evt"]))
    const wrapper = mountCard()
    await flushPromises()

    auth.setActiveContext("beta") // no session for beta yet
    await flushPromises()

    expect(mockedJson).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).not.toContain("alpha-evt")
    expect(wrapper.text()).toContain("No recent events.")
  })

  // A response from the old cluster that lands after the switch must not
  // repopulate the table.
  it("discards an in-flight response from the previous context", async () => {
    const auth = useAuthStore()
    auth.setSession("alpha", "tok-alpha", null, false)
    let resolveAlpha!: (v: K8sObjectList) => void
    mockedJson
      .mockReturnValueOnce(new Promise<K8sObjectList>((r) => (resolveAlpha = r)) as Promise<unknown>)
      .mockResolvedValueOnce(eventList(["beta-evt"]))

    const wrapper = mountCard()
    auth.setSession("beta", "tok-beta", null, false)
    await flushPromises()

    resolveAlpha(eventList(["alpha-evt"]))
    await flushPromises()

    expect(wrapper.text()).toContain("beta-evt")
    expect(wrapper.text()).not.toContain("alpha-evt")
  })

  it("shows a warnings-specific empty message when no warnings exist", async () => {
    mockedJson.mockResolvedValue(eventList(["normal-evt"]))
    const prefs = usePreferencesStore()
    prefs.prefs.eventsOnlyWarnings = true
    const wrapper = mountCard()
    await flushPromises()

    expect(wrapper.text()).toContain("No recent warnings.")
    expect(wrapper.text()).not.toContain("normal-evt")
  })
})
