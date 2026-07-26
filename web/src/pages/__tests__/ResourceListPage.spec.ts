import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { computed } from "vue"

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
vi.mock("vue-router", () => ({
  useRouter: () => ({ push: routerPush }),
  RouterLink: { props: ["to"], template: "<a><slot /></a>" },
}))

import { walkTable } from "@/api/k8s"
import ResourceTable from "@/components/table/ResourceTable.vue"
import ResourceListPage from "@/pages/ResourceListPage.vue"
import { useAuthStore } from "@/stores/auth"
import { useUiStore } from "@/stores/ui"

const mockedWalk = vi.mocked(walkTable)

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
