import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { computed, reactive } from "vue"

import type { DiscoveryResource, K8sTable, K8sTableRow, WatchEvent } from "@/api/types"

vi.mock("@/api/k8s", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/k8s")>()
  return { ...actual, walkTable: vi.fn() }
})

// The watch transport is covered in useWatch.spec; faked here so a test can
// deliver one event and observe what the page re-projects because of it.
const watchFake = vi.hoisted(() => ({
  onEvent: undefined as ((event: WatchEvent) => void) | undefined,
}))
vi.mock("@/composables/useWatch", () => ({
  useWatch: (opts: { onEvent: (event: WatchEvent) => void }) => {
    watchFake.onEvent = opts.onEvent
    return { start: () => {}, stop: () => {} }
  },
}))

const DEPLOYMENTS: DiscoveryResource = {
  id: "apps/v1/deployments",
  group: "apps",
  version: "v1",
  resource: "deployments",
  kind: "Deployment",
  namespaced: true,
  verbs: ["get", "list"],
}
vi.mock("@/composables/useDiscovery", () => ({
  useDiscovery: () => ({
    resources: computed(() => [DEPLOYMENTS]),
    findResource: () => DEPLOYMENTS,
    findByLowerKind: () => undefined,
  }),
}))
const routerPush = vi.hoisted(() => vi.fn())
const routerReplace = vi.hoisted(() => vi.fn())
const historyReplace = vi.hoisted(() => vi.fn())
// The page's route guards, captured so a test can start a navigation.
const guards = vi.hoisted(() => ({
  leave: undefined as (() => void) | undefined,
  update: undefined as (() => void) | undefined,
}))
vi.mock("vue-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-router")>()),
  useRouter: () => ({
    push: routerPush,
    replace: routerReplace,
    resolve: (to: { query: Record<string, string> }) => ({
      fullPath: `/r/apps/v1/deployments?${new URLSearchParams(to.query).toString()}`,
    }),
    afterEach: () => () => {},
    options: { history: { replace: historyReplace } },
  }),
  // Read lazily: the factory is hoisted above `routeState`'s declaration.
  useRoute: () => routeState,
  onBeforeRouteLeave: (guard: () => void) => {
    guards.leave = guard
  },
  onBeforeRouteUpdate: (guard: () => void) => {
    guards.update = guard
  },
  RouterLink: { props: ["to"], template: "<a><slot /></a>" },
}))

import { walkTable } from "@/api/k8s"
import ResourceTable from "@/components/table/ResourceTable.vue"
import ResourceListPage from "@/pages/ResourceListPage.vue"
import { useAuthStore } from "@/stores/auth"
import { useUiStore } from "@/stores/ui"

const mockedWalk = vi.mocked(walkTable)

// The current route as the page sees it. `routerReplace` writes the query back,
// as the real router would, so a sync loop would show up as repeated calls.
const routeState = reactive({ name: "resource-list", query: {} as Record<string, string> })
function resetRoute(query: Record<string, string> = {}): void {
  routeState.query = query
  routerReplace.mockReset()
  routerReplace.mockImplementation((to: { query: Record<string, string> }) => {
    routeState.query = to.query
    return Promise.resolve()
  })
}

// Give the virtualizer a viewport: jsdom has no layout, so without both the
// rect and offsetWidth/offsetHeight it renders zero rows and every row
// assertion below would pass vacuously (see CLAUDE.md, testing conventions).
const originalGetRect = Element.prototype.getBoundingClientRect
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 1024,
      height: 640,
      top: 0,
      left: 0,
      bottom: 640,
      right: 1024,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1024 })
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 640 })
})
afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetRect
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth)
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight)
})

const columnDefinitions = [
  { name: "Name", type: "string" },
  { name: "Ready", type: "string" },
]

function deployment(namespace: string, name: string, ready: string): K8sTableRow {
  return {
    cells: [name, ready],
    object: { metadata: { name, namespace, uid: `uid-${namespace}-${name}` } },
  }
}

function walkOf(rows: K8sTableRow[]) {
  return async () => ({
    columnDefinitions,
    rows,
    fallback: false,
    resourceVersion: "1",
    continueToken: "",
    truncated: false,
    scanned: rows.length,
  })
}

/** Deliver one Table-typed watch event, as the live watch would. */
function emitEvent(type: WatchEvent["type"], rows: K8sTableRow[]): void {
  if (watchFake.onEvent === undefined) throw new Error("watch not wired")
  const table: K8sTable = {
    kind: "Table",
    columnDefinitions,
    metadata: { resourceVersion: "2" },
    rows,
  }
  watchFake.onEvent({ type, object: table } as unknown as WatchEvent)
}

const mounted: Array<ReturnType<typeof mount>> = []

async function mountPage() {
  const wrapper = mount(ResourceListPage, {
    props: { group: "apps", version: "v1", resource: "deployments" },
    global: {
      stubs: {
        CreateResourceDialog: true,
        RouterLink: { props: ["to"], template: "<a><slot /></a>" },
      },
    },
  })
  mounted.push(wrapper)
  await flushPromises()
  await wrapper.vm.$nextTick()
  return wrapper
}

/** Rendered body cells, row by row (the header carries role="columnheader"). */
function renderedRows(wrapper: ReturnType<typeof mount>): string[][] {
  return wrapper
    .findAll('[role="row"]')
    .filter((r) => r.findAll('[role="cell"]').length > 0)
    .map((r) => r.findAll('[role="cell"]').map((c) => c.text()))
}

function tableRows(wrapper: ReturnType<typeof mount>): K8sTableRow[] {
  return wrapper.getComponent(ResourceTable).props("rows") as K8sTableRow[]
}

describe("ResourceListPage in all-namespaces mode", () => {
  beforeEach(() => {
    // The selected namespace and the session both live in sessionStorage, which
    // outlives a pinia reset: "" (all namespaces) is what this suite is about.
    window.sessionStorage.clear()
    setActivePinia(createPinia())
    mockedWalk.mockReset()
    routerPush.mockReset()
    resetRoute()
    watchFake.onEvent = undefined
    useAuthStore().setSession("alpha", "tok-alpha", null, false)
  })

  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
  })

  // Regression: the row the table hands back is the *projected* one, whose cell
  // 0 is the injected Namespace — so openDetail's Name fallback read the
  // namespace and navigated to an object that cannot exist. Only reachable when
  // the row carries no object metadata (a server answering the Table request
  // without it), which is exactly why the aliasing went unnoticed.
  it("opens the right object when a row carries no metadata", async () => {
    mockedWalk.mockImplementation(
      walkOf([{ cells: ["api", "1/1"], object: { metadata: { namespace: "team-a" } } }]),
    )
    const wrapper = await mountPage()
    expect(renderedRows(wrapper)).toEqual([["team-a", "api", "1/1"]])

    await wrapper
      .findAll('[role="row"]')
      .filter((r) => r.findAll('[role="cell"]').length > 0)[0]!
      .trigger("click")

    expect(routerPush).toHaveBeenCalledTimes(1)
    const route = routerPush.mock.calls[0]![0] as { params: Record<string, string> }
    expect(route.params.name).toBe("api")
    expect(route.params.namespace).toBe("team-a")
  })

  it("renders the injected Namespace column for every row", async () => {
    mockedWalk.mockImplementation(
      walkOf([deployment("team-a", "api", "1/1"), deployment("team-b", "web", "0/1")]),
    )
    const wrapper = await mountPage()

    // Guard the guard: a zero-row table would make every assertion vacuous.
    expect(renderedRows(wrapper)).toEqual([
      ["team-a", "api", "1/1"],
      ["team-b", "web", "0/1"],
    ])
  })

  // Regression: the projection allocated a row object and a cells array per row
  // on every watch event, re-projecting the whole collection (up to 5000 rows)
  // to absorb the one row that changed.
  it("reuses the projection of rows an event did not touch", async () => {
    mockedWalk.mockImplementation(
      walkOf([deployment("team-a", "api", "1/1"), deployment("team-b", "web", "0/1")]),
    )
    const wrapper = await mountPage()
    const before = tableRows(wrapper)
    expect(before).toHaveLength(2)

    emitEvent("MODIFIED", [deployment("team-b", "web", "1/1")])
    await wrapper.vm.$nextTick()
    const after = tableRows(wrapper)

    expect(after).not.toBe(before) // new array: the table rebuilds on identity
    expect(after[0]).toBe(before[0]) // untouched row: same projected object
    expect(after[1]).not.toBe(before[1])
    expect(renderedRows(wrapper)).toEqual([
      ["team-a", "api", "1/1"],
      ["team-b", "web", "1/1"],
    ])
  })

  it("keeps namespaces right for rows added and removed by events", async () => {
    mockedWalk.mockImplementation(walkOf([deployment("team-a", "api", "1/1")]))
    const wrapper = await mountPage()

    emitEvent("ADDED", [deployment("team-b", "api", "2/2")])
    await wrapper.vm.$nextTick()
    expect(renderedRows(wrapper)).toEqual([
      ["team-a", "api", "1/1"],
      ["team-b", "api", "2/2"],
    ])

    emitEvent("DELETED", [deployment("team-a", "api", "1/1")])
    await wrapper.vm.$nextTick()
    expect(renderedRows(wrapper)).toEqual([["team-b", "api", "2/2"]])
  })

  it("drops the Namespace column when a single namespace is selected", async () => {
    useUiStore().namespace = "team-a"
    mockedWalk.mockImplementation(walkOf([deployment("team-a", "api", "1/1")]))
    const wrapper = await mountPage()

    expect(renderedRows(wrapper)).toEqual([["api", "1/1"]])
  })
})

describe("ResourceListPage URL query", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    setActivePinia(createPinia())
    mockedWalk.mockReset()
    mockedWalk.mockImplementation(walkOf([deployment("team-a", "api", "1/1")]))
    routerPush.mockReset()
    historyReplace.mockReset()
    guards.leave = undefined
    guards.update = undefined
    resetRoute()
    watchFake.onEvent = undefined
    useAuthStore().setSession("alpha", "tok-alpha", null, false)
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
  })

  type WalkOptions = { namespace?: string; labelSelector?: string; keepRow?: unknown }

  function lastWalkOptions(): WalkOptions {
    const calls = mockedWalk.mock.calls
    return calls[calls.length - 1]![1] as WalkOptions
  }

  function lastReplacedQuery(): Record<string, string> | undefined {
    const calls = routerReplace.mock.calls
    return (calls[calls.length - 1]?.[0] as { query: Record<string, string> } | undefined)?.query
  }

  /** A walk that stops at the load cap: a continue token is left over. */
  function cappedWalk() {
    return async () => ({ ...(await walkOf([deployment("team-a", "api", "1/1")])()), continueToken: "more" })
  }

  const filterInput = (w: ReturnType<typeof mount>) => w.find('input[type="search"]')
  const selectorInput = (w: ReturnType<typeof mount>) => w.find('input[type="text"]')

  it("lists with the namespace, selector and filter the URL names", async () => {
    resetRoute({ namespace: "team-a", filter: "api", selector: "app=web" })
    const wrapper = await mountPage()

    expect(useUiStore().namespace).toBe("team-a")
    expect(lastWalkOptions()).toMatchObject({ namespace: "team-a", labelSelector: "app=web" })
    expect(wrapper.getComponent(ResourceTable).props("globalFilter")).toBe("api")
    expect((filterInput(wrapper).element as HTMLInputElement).value).toBe("api")
    // Already in sync: nothing to write back.
    expect(routerReplace).not.toHaveBeenCalled()
  })

  // Defaults never reach the URL: an unfiltered list in all namespaces keeps
  // the bare one it was opened with.
  it("leaves the URL bare for an unfiltered list in all namespaces", async () => {
    await mountPage()
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it("writes a selected namespace into a bare URL", async () => {
    useUiStore().namespace = "team-b"
    await mountPage()
    expect(lastReplacedQuery()).toEqual({ namespace: "team-b" })
  })

  it("drops the namespace again on switching to all namespaces", async () => {
    resetRoute({ namespace: "team-a" })
    await mountPage()
    useUiStore().namespace = ""
    await flushPromises()
    expect(lastReplacedQuery()).toEqual({})
  })

  it("ignores a namespace that cannot name one and rewrites the URL", async () => {
    useUiStore().namespace = "team-a"
    resetRoute({ namespace: "../kube-system" })
    await mountPage()

    expect(useUiStore().namespace).toBe("team-a")
    expect(lastWalkOptions().namespace).toBe("team-a")
    expect(lastReplacedQuery()).toEqual({ namespace: "team-a" })
  })

  // Regression: every keystroke was a full router navigation and a
  // history.replaceState call, which browsers throttle.
  it("debounces filter keystrokes into one write", async () => {
    const wrapper = await mountPage()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

    await filterInput(wrapper).setValue("w")
    await filterInput(wrapper).setValue("we")
    expect(routerReplace).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)
    expect(routerReplace).toHaveBeenCalledTimes(1)
    expect(lastReplacedQuery()).toEqual({ filter: "we" })
  })

  // The selector field is a draft until Enter/Refresh lists with it: a URL
  // carrying a half-typed selector would describe rows nobody listed.
  it("writes the label selector only once it is applied", async () => {
    const wrapper = await mountPage()
    await selectorInput(wrapper).setValue("app=web")
    expect(routerReplace).not.toHaveBeenCalled()

    await selectorInput(wrapper).trigger("keydown", { key: "Enter" })
    await flushPromises()
    expect(lastWalkOptions().labelSelector).toBe("app=web")
    expect(lastReplacedQuery()).toEqual({ selector: "app=web" })
  })

  it("refreshes on Enter when the selector did not change", async () => {
    resetRoute({ selector: "app=web" })
    const wrapper = await mountPage()
    expect(mockedWalk).toHaveBeenCalledTimes(1)

    await selectorInput(wrapper).trigger("keydown", { key: "Enter" })
    await flushPromises()
    expect(mockedWalk).toHaveBeenCalledTimes(2)
    expect(lastWalkOptions().labelSelector).toBe("app=web")
  })

  // Regression: with the reset gone, a namespace switch listed with whatever
  // half-typed text sat in the selector field — and wrote it into the URL.
  it("lists a namespace switch with the applied selector, not the draft", async () => {
    resetRoute({ selector: "app=web" })
    const wrapper = await mountPage()
    await selectorInput(wrapper).setValue("app=")

    useUiStore().namespace = "team-b"
    await flushPromises()

    expect(lastWalkOptions()).toMatchObject({ namespace: "team-b", labelSelector: "app=web" })
    expect(lastReplacedQuery()).toEqual({ namespace: "team-b", selector: "app=web" })
  })

  // Regression: the name search read the draft selector too, so the scan and
  // the URL described different collections.
  it("runs the name search with the applied selector, not the draft", async () => {
    mockedWalk.mockImplementation(cappedWalk())
    resetRoute({ selector: "app=web" })
    const wrapper = await mountPage()
    await selectorInput(wrapper).setValue("app=db")
    await filterInput(wrapper).setValue("api")

    await filterInput(wrapper).trigger("keydown", { key: "Enter" })
    await flushPromises()

    expect(lastWalkOptions().keepRow).toBeDefined()
    expect(lastWalkOptions().labelSelector).toBe("app=web")
  })

  // Regression: a filter restored from the URL on a capped collection filtered
  // the loaded window only, with nothing saying the result was partial.
  it("runs a URL filter as a name search when the listing is capped", async () => {
    mockedWalk.mockImplementation(cappedWalk())
    resetRoute({ filter: "api" })
    const wrapper = await mountPage()

    expect(mockedWalk).toHaveBeenCalledTimes(2)
    expect(lastWalkOptions().keepRow).toBeDefined()
    expect(wrapper.text()).toContain("Name search “api”")
  })

  it("does not search when the whole collection is loaded", async () => {
    resetRoute({ filter: "api" })
    await mountPage()
    expect(mockedWalk).toHaveBeenCalledTimes(1)
  })

  // Regression: only a resource change adopted the URL, so a sidebar click on
  // the list already open (a bare URL, same path) left the filters on screen
  // under a URL without them — and Back between two such entries changed the
  // URL alone.
  it("adopts a query landing on the same list", async () => {
    resetRoute({ filter: "api", selector: "app=web" })
    const wrapper = await mountPage()

    routeState.query = {}
    await flushPromises()
    expect(wrapper.getComponent(ResourceTable).props("globalFilter")).toBe("")
    expect(lastWalkOptions().labelSelector).toBe("")
    expect(routerReplace).not.toHaveBeenCalled()

    routeState.query = { filter: "web" }
    await flushPromises()
    expect(wrapper.getComponent(ResourceTable).props("globalFilter")).toBe("web")
  })

  it("takes the next resource's filters from its own URL", async () => {
    resetRoute({ namespace: "team-a", filter: "api", selector: "app=web" })
    const wrapper = await mountPage()

    // A sidebar link: a bare list route for another resource.
    routeState.query = {}
    await wrapper.setProps({ resource: "statefulsets" })
    await flushPromises()

    expect(wrapper.getComponent(ResourceTable).props("globalFilter")).toBe("")
    expect(lastWalkOptions()).toMatchObject({ namespace: "team-a", labelSelector: "" })
    // The namespace is global: absent from the URL means "keep it".
    expect(useUiStore().namespace).toBe("team-a")
    expect(lastReplacedQuery()).toEqual({ namespace: "team-a" })
  })

  it("lists once for a navigation that also brings a namespace", async () => {
    const wrapper = await mountPage()
    expect(mockedWalk).toHaveBeenCalledTimes(1)

    routeState.query = { namespace: "team-c", selector: "app=db" }
    await wrapper.setProps({ resource: "statefulsets" })
    await flushPromises()

    expect(mockedWalk).toHaveBeenCalledTimes(2)
    expect(lastWalkOptions()).toMatchObject({ namespace: "team-c", labelSelector: "app=db" })
  })

  it("keeps the filters across a namespace switch", async () => {
    resetRoute({ namespace: "team-a", filter: "api", selector: "app=web" })
    const wrapper = await mountPage()

    useUiStore().namespace = "team-b"
    await flushPromises()

    expect(lastWalkOptions()).toMatchObject({ namespace: "team-b", labelSelector: "app=web" })
    expect(wrapper.getComponent(ResourceTable).props("globalFilter")).toBe("api")
    expect(lastReplacedQuery()).toEqual({ namespace: "team-b", filter: "api", selector: "app=web" })
  })

  it("leaves another route's URL alone", async () => {
    routeState.name = "resource-detail"
    try {
      useUiStore().namespace = "team-a"
      await mountPage()
      expect(routerReplace).not.toHaveBeenCalled()
    } finally {
      routeState.name = "resource-list"
    }
  })

  // Regression: a replace issued while a navigation away was pending became
  // the newer navigation and cancelled it — the row click was lost.
  it("writes nothing once a navigation away has started", async () => {
    await mountPage()
    guards.leave!()

    useUiStore().namespace = "team-c"
    await flushPromises()
    expect(routerReplace).not.toHaveBeenCalled()

    // Superseded by a navigation that keeps this page: writing resumes.
    guards.update!()
    useUiStore().namespace = "team-d"
    await flushPromises()
    expect(lastReplacedQuery()).toEqual({ namespace: "team-d" })
  })

  it("flushes a pending filter write into the entry being left", async () => {
    const wrapper = await mountPage()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    await filterInput(wrapper).setValue("we")

    guards.leave!()
    // Straight into the history entry: a router.replace would cancel the leave.
    expect(historyReplace).toHaveBeenCalledWith("/r/apps/v1/deployments?filter=we")
    vi.advanceTimersByTime(300)
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it("remembers the shown query for the detail page's way back", async () => {
    resetRoute({ namespace: "team-a", filter: "api" })
    const wrapper = await mountPage()
    expect(useUiStore().listQueryFor("apps/v1/deployments")).toEqual({
      namespace: "team-a",
      filter: "api",
    })

    await filterInput(wrapper).setValue("")
    expect(useUiStore().listQueryFor("apps/v1/deployments")).toEqual({ namespace: "team-a" })
  })
})
