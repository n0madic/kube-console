import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, ref } from "vue"

vi.mock("@/composables/useDiscovery", () => ({ useDiscovery: vi.fn() }))

import type { DiscoveryResource } from "@/api/types"
import { useDiscovery } from "@/composables/useDiscovery"
import Sidebar from "@/components/layout/Sidebar.vue"
import { usePreferencesStore } from "@/stores/preferences"
import { useUiStore } from "@/stores/ui"
import { stubViewport, type ViewportStub } from "@/test/viewport"

const mockedDiscovery = vi.mocked(useDiscovery)

const routerLinkStub = {
  RouterLink: { props: ["to"], template: "<a :data-to='to'><slot /></a>" },
  // ClusterSelector, ClusterName and AppVersion pull in vue-query (contexts);
  // each is exercised in its own spec, so stub them out here.
  ClusterSelector: true,
  ClusterName: true,
  AppVersion: true,
}

function mockDiscovery(over: Partial<Record<string, unknown>> = {}) {
  mockedDiscovery.mockReturnValue({
    resources: ref([]),
    isLoading: ref(true),
    isError: ref(false),
    ...over,
  } as unknown as ReturnType<typeof useDiscovery>)
}

let viewport: ViewportStub

describe("Sidebar", () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
    mockedDiscovery.mockReset()
    viewport = stubViewport(false)
  })

  afterEach(() => {
    viewport.restore()
  })

  it("always shows an Overview link, even while resources are still loading", () => {
    mockDiscovery({ isLoading: ref(true) })
    const wrapper = mount(Sidebar, { global: { stubs: routerLinkStub } })

    // Discovery is loading, so no resource sections render yet...
    expect(wrapper.text()).toContain("Loading API resources...")
    // ...but the Overview nav link is present and points to /overview.
    const overview = wrapper
      .findAll("a")
      .find((a) => a.text().includes("Overview") && a.attributes("data-to") === "/overview")
    expect(overview).toBeDefined()
  })

  // Collapsing hides the sidebar outright (its entries are text Kinds with no
  // icons of their own, so an icon rail would say nothing); on a narrow
  // viewport it overlays the content instead of squeezing it.
  describe("collapse", () => {
    function toggleOf(wrapper: ReturnType<typeof mount>) {
      return wrapper.findAll("button").find((b) => b.attributes("aria-controls") === "app-sidebar")
    }

    it("hides itself, and its toggle, when the sidebar is collapsed", async () => {
      mockDiscovery({ isLoading: ref(true) })
      const prefs = usePreferencesStore()
      const wrapper = mount(Sidebar, { global: { stubs: routerLinkStub } })
      const aside = wrapper.get("#app-sidebar")
      expect(aside.attributes("style") ?? "").not.toContain("display: none")
      // While open, the toggle lives in this header — the TopBar has none.
      expect(toggleOf(wrapper)?.attributes("aria-label")).toBe("Hide sidebar")

      prefs.prefs.sidebarCollapsed = true
      await nextTick()

      expect(aside.attributes("style")).toContain("display: none")
      expect(toggleOf(wrapper)).toBeUndefined()
    })

    it("hides the sidebar from its own header toggle", async () => {
      mockDiscovery({ isLoading: ref(true) })
      const prefs = usePreferencesStore()
      const wrapper = mount(Sidebar, { global: { stubs: routerLinkStub } })

      await toggleOf(wrapper)!.trigger("click")
      await nextTick()

      expect(prefs.prefs.sidebarCollapsed).toBe(true)
      expect(wrapper.get("#app-sidebar").attributes("style")).toContain("display: none")
    })

    it("floats over the content in drawer mode", async () => {
      mockDiscovery({ isLoading: ref(true) })
      const ui = useUiStore()
      const wrapper = mount(Sidebar, { global: { stubs: routerLinkStub } })
      expect(wrapper.get("#app-sidebar").classes()).not.toContain("fixed")

      // Narrow viewport, then the drawer opened by the user. The mode change
      // resets the drawer on flush, so it has to settle before the toggle.
      viewport.set(true)
      await nextTick()
      ui.toggleSidebar()
      await nextTick()

      const aside = wrapper.get("#app-sidebar")
      expect(aside.attributes("style") ?? "").not.toContain("display: none")
      expect(aside.classes()).toContain("fixed")

      // The header toggle closes the drawer without touching the saved choice.
      await toggleOf(wrapper)!.trigger("click")
      await nextTick()

      expect(ui.sidebarOpen).toBe(false)
      expect(usePreferencesStore().prefs.sidebarCollapsed).toBe(false)
      expect(aside.attributes("style")).toContain("display: none")
    })

    // A link both navigates and dismisses the drawer covering the page it leads
    // to — including a tap on the page already open, which changes no route.
    // It must not claim the focus back: that belongs to the new view.
    it("closes the drawer from a nav link without taking the focus", async () => {
      mockDiscovery({ isLoading: ref(true) })
      const ui = useUiStore()
      const wrapper = mount(Sidebar, { global: { stubs: routerLinkStub } })

      viewport.set(true)
      await nextTick()
      ui.toggleSidebar()
      await nextTick()
      ui.consumeToggleFocus() // the toggle's own handoff
      expect(ui.sidebarOpen).toBe(true)

      const overview = wrapper
        .findAll("a")
        .find((a) => a.attributes("data-to") === "/overview")
      await overview!.trigger("click")

      expect(ui.sidebarOpen).toBe(false)
      expect(ui.consumeToggleFocus()).toBe(false)
    })
  })

  describe("pinned reordering", () => {
    function res(name: string): DiscoveryResource {
      return {
        id: `v1/${name}`,
        group: "",
        version: "v1",
        resource: name,
        kind: name,
        namespaced: true,
        verbs: ["list"],
      }
    }

    function mountWithPinned(ids: string[]) {
      const all = [res("pods"), res("services"), res("nodes")]
      mockDiscovery({ resources: ref(all), isLoading: ref(false), isError: ref(false) })
      const prefs = usePreferencesStore()
      prefs.prefs.pinnedResources = [...ids]
      const wrapper = mount(Sidebar, { global: { stubs: routerLinkStub } })
      return { wrapper, prefs }
    }

    it("reorders pinned resources on drop", async () => {
      const { wrapper, prefs } = mountWithPinned(["v1/pods", "v1/services", "v1/nodes"])
      const rows = wrapper.findAll("[data-pin-id]")
      expect(rows.map((r) => r.attributes("data-pin-id"))).toEqual([
        "v1/pods",
        "v1/services",
        "v1/nodes",
      ])

      await rows[0]!.trigger("dragstart")
      await rows[2]!.trigger("dragover")
      await rows[2]!.trigger("drop")

      expect(prefs.prefs.pinnedResources).toEqual(["v1/services", "v1/nodes", "v1/pods"])
      expect(wrapper.findAll("[data-pin-id]").map((r) => r.attributes("data-pin-id"))).toEqual([
        "v1/services",
        "v1/nodes",
        "v1/pods",
      ])
    })

    it("marks the drop target with an insertion line and clears it on dragend", async () => {
      const { wrapper } = mountWithPinned(["v1/pods", "v1/services"])
      const rows = wrapper.findAll("[data-pin-id]")

      await rows[0]!.trigger("dragstart")
      await rows[1]!.trigger("dragover")
      // Dragging downwards: the line sits below the target.
      expect(rows[1]!.classes()).toContain("border-b-amber-400")

      await rows[0]!.trigger("dragend")
      expect(rows[1]!.classes()).not.toContain("border-b-amber-400")
    })

    it("is not draggable with a single pinned resource", () => {
      const { wrapper } = mountWithPinned(["v1/pods"])
      expect(wrapper.find("[data-pin-id]").attributes("draggable")).toBe("false")
    })
  })

  describe("collapsible sections", () => {
    function res(group: string, name: string, kind: string): DiscoveryResource {
      return {
        id: `${group}/v1/${name}`,
        group,
        version: "v1",
        resource: name,
        kind,
        namespaced: true,
        verbs: ["list"],
      }
    }

    // Buckets into Workloads (pods) and Networking (services).
    const resources = [res("", "pods", "Pod"), res("", "services", "Service")]

    function mountWithCatalog(pinnedIds: string[] = []) {
      mockDiscovery({ resources: ref(resources), isLoading: ref(false), isError: ref(false) })
      const prefs = usePreferencesStore()
      prefs.prefs.pinnedResources = [...pinnedIds]
      return mount(Sidebar, { global: { stubs: routerLinkStub } })
    }

    function header(wrapper: ReturnType<typeof mountWithCatalog>, name: string) {
      const button = wrapper.findAll("button").find((b) => b.text().includes(name))
      expect(button).toBeDefined()
      return button!
    }

    it("expands every section when nothing is pinned", () => {
      const wrapper = mountWithCatalog()
      expect(wrapper.text()).toContain("Pod")
      expect(wrapper.text()).toContain("Service")
      expect(header(wrapper, "Workloads").attributes("aria-expanded")).toBe("true")
    })

    it("toggles a section on a header click", async () => {
      const wrapper = mountWithCatalog()
      const workloads = header(wrapper, "Workloads")

      await workloads.trigger("click")
      expect(workloads.attributes("aria-expanded")).toBe("false")
      expect(wrapper.text()).not.toContain("Pod")
      // Other sections are unaffected.
      expect(wrapper.text()).toContain("Service")

      await workloads.trigger("click")
      expect(wrapper.text()).toContain("Pod")
    })

    it("starts fully collapsed when a pinned resource exists", () => {
      const wrapper = mountWithCatalog(["/v1/pods"])
      expect(header(wrapper, "Workloads").attributes("aria-expanded")).toBe("false")
      expect(header(wrapper, "Networking").attributes("aria-expanded")).toBe("false")
      // The Pinned block itself stays visible — it is the entry point.
      expect(wrapper.find("[data-pin-id]").exists()).toBe(true)
    })

    it("ignores collapsed state while searching, and restores it afterwards", async () => {
      const wrapper = mountWithCatalog(["/v1/pods"])
      const ui = useUiStore()
      expect(wrapper.text()).not.toContain("Service")

      ui.sidebarSearch = "service"
      await nextTick()
      expect(wrapper.text()).toContain("Service")

      ui.sidebarSearch = ""
      await nextTick()
      expect(wrapper.text()).not.toContain("Service")
    })
  })
})
