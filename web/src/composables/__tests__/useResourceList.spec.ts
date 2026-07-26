import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"

import type { TableWalkOptions, WalkResult } from "@/api/k8s"
import type { K8sObjectMeta, K8sTable, K8sTableRow, ResourceRef, WatchEvent } from "@/api/types"

vi.mock("@/api/k8s", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/k8s")>()
  return { ...actual, walkTable: vi.fn() }
})

// The watch transport (NDJSON framing, bookmarks, 410, backoff) is covered in
// useWatch.spec; faking it here hands a test one event at a time so what
// useResourceList does with the collection is observable — and keeps every spec
// in this file from opening a real stream in the background.
const watchFake = vi.hoisted(() => ({
  onEvent: undefined as ((event: WatchEvent) => void) | undefined,
}))
vi.mock("@/composables/useWatch", () => ({
  useWatch: (opts: { onEvent: (event: WatchEvent) => void }) => {
    watchFake.onEvent = opts.onEvent
    return { start: () => {}, stop: () => {} }
  },
}))

import { walkTable } from "@/api/k8s"
import { useResourceList, type ResourceListOptions } from "@/composables/useResourceList"
import { useAuthStore } from "@/stores/auth"

const mockedWalk = vi.mocked(walkTable)

function row(name: string): K8sTableRow {
  return { cells: [name], object: { metadata: { name, uid: `uid-${name}` } } }
}

// Stand-in for the real walkTable: applies the caller's keepRow/maxRows to a
// canned server-side name set, so useResourceList's own matching closure and
// result wiring are exercised. The pagination walk itself is covered directly
// in api/__tests__/k8s.spec.ts.
function walkOf(serverNames: string[], continueToken = "") {
  return async (_ref: ResourceRef, opts: TableWalkOptions = {}): Promise<WalkResult> => {
    let rows = serverNames.map(row)
    if (opts.keepRow !== undefined) rows = rows.filter((r) => opts.keepRow!(r))
    let cont = continueToken
    if (opts.maxRows !== undefined && rows.length > opts.maxRows) {
      rows = rows.slice(0, opts.maxRows)
      if (cont === "") cont = "capped" // more matches remained
    }
    return {
      columnDefinitions: [{ name: "Name", type: "string" }],
      rows,
      fallback: false,
      resourceVersion: "1",
      continueToken: cont,
      truncated: cont !== "",
      scanned: serverNames.length,
    }
  }
}

const podsRef: ResourceRef = { group: "", version: "v1", resource: "pods" }

function setupList(
  getRef: () => ResourceRef | null = () => podsRef,
  getOptions: () => ResourceListOptions = () => ({ pageSize: 50 }),
) {
  let list!: ReturnType<typeof useResourceList>
  const Host = defineComponent({
    setup() {
      list = useResourceList(getRef, getOptions)
      return () => h("div")
    },
  })
  mount(Host)
  return list
}

/** Deliver one Table-typed watch event, as the live watch would. */
function emitEvent(type: WatchEvent["type"], eventRows: K8sTableRow[], rv = "2"): void {
  if (watchFake.onEvent === undefined) throw new Error("watch not wired")
  const table: K8sTable = {
    kind: "Table",
    columnDefinitions: [{ name: "Name", type: "string" }],
    metadata: { resourceVersion: rv },
    rows: eventRows,
  }
  watchFake.onEvent({ type, object: table } as unknown as WatchEvent)
}

function names(rows: K8sTableRow[]): Array<string | undefined> {
  return rows.map((r) => r.object?.metadata?.name)
}

describe("useResourceList.refresh", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedWalk.mockReset()
  })

  it("surfaces the walked collection so sorting covers everything", async () => {
    mockedWalk.mockImplementation(walkOf(["zeta", "alpha", "mid"], ""))

    const list = setupList()
    await list.refresh()

    expect(mockedWalk).toHaveBeenCalledTimes(1)
    // The whole (bounded) collection is loaded in one walk, not page by page.
    expect(mockedWalk.mock.calls[0]?.[1]).toMatchObject({ maxPages: 10, continueToken: "" })
    expect(list.rows.value.map((r) => r.object?.metadata?.name)).toEqual(["zeta", "alpha", "mid"])
    expect(list.hasNextPage.value).toBe(false)
    list.stopWatch()
  })

  it("keeps a continue token when the walk reports more rows", async () => {
    mockedWalk.mockImplementation(walkOf(["a", "b"], "more"))
    const list = setupList()
    await list.refresh()
    expect(list.rows.value).toHaveLength(2)
    expect(list.hasNextPage.value).toBe(true)
    list.stopWatch()
  })

  it("reloads from the new cluster when the active context changes", async () => {
    mockedWalk.mockImplementation(walkOf(["alpha-pod"], ""))
    const list = setupList()
    await list.refresh()
    expect(mockedWalk).toHaveBeenCalledTimes(1)

    // Switching to an AUTHORIZED context must trigger a fresh walk (against the
    // new cluster). setSession stores beta's token and activates it.
    mockedWalk.mockImplementation(walkOf(["beta-pod"], ""))
    useAuthStore().setSession("beta", "tok-b", null, false)
    await new Promise((r) => setTimeout(r, 0)) // let the watch-driven refresh run
    expect(mockedWalk.mock.calls.length).toBeGreaterThan(1)
    expect(list.rows.value.map((r) => r.object?.metadata?.name)).toEqual(["beta-pod"])
    list.stopWatch()
  })

  it("clears stale rows/columns immediately when a new load starts", async () => {
    mockedWalk.mockImplementation(walkOf(["zeta", "alpha"], ""))
    const list = setupList()
    await list.refresh()
    expect(list.rows.value).toHaveLength(2)
    expect(list.columns.value).toHaveLength(1)

    let resolveWalk!: (r: WalkResult) => void
    mockedWalk.mockImplementation(
      () =>
        new Promise<WalkResult>((resolve) => {
          resolveWalk = resolve
        }),
    )
    const pending = list.refresh()
    // Synchronously, before the new walk resolves: the previous resource
    // type's rows/columns must already be gone (no stale-data flash).
    expect(list.rows.value).toHaveLength(0)
    expect(list.columns.value).toHaveLength(0)
    expect(list.loading.value).toBe(true)

    resolveWalk({
      columnDefinitions: [{ name: "Name", type: "string" }],
      rows: [row("beta")],
      fallback: false,
      resourceVersion: "2",
      continueToken: "",
      truncated: false,
      scanned: 1,
    })
    await pending
    expect(list.rows.value.map((r) => r.object?.metadata?.name)).toEqual(["beta"])
    list.stopWatch()
  })

  it("skips the reload when the new context has no session (login-bound switch)", async () => {
    mockedWalk.mockImplementation(walkOf(["alpha-pod"], ""))
    const list = setupList()
    await list.refresh()
    expect(mockedWalk).toHaveBeenCalledTimes(1)

    // No session for beta: the switcher routes to login; a tokenless walk must
    // not fire (it would 401 through the global logout handler).
    useAuthStore().setActiveContext("beta")
    await new Promise((r) => setTimeout(r, 0))
    expect(mockedWalk).toHaveBeenCalledTimes(1)
    list.stopWatch()
  })
})

describe("useResourceList.searchAllByName", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedWalk.mockReset()
  })

  it("skips the server scan when the full collection is already loaded", async () => {
    mockedWalk.mockImplementation(walkOf(["api-server", "db-1"], ""))
    const list = setupList()
    await list.refresh()
    expect(mockedWalk).toHaveBeenCalledTimes(1)

    await list.searchAllByName("api")
    // No extra walk, no synthetic search mode: the live filter covers it.
    expect(mockedWalk).toHaveBeenCalledTimes(1)
    expect(list.searchQuery.value).toBeNull()
    expect(list.rows.value).toHaveLength(2)
    list.stopWatch()
  })

  it("runs the server scan when the view is truncated", async () => {
    mockedWalk.mockImplementation(walkOf(["x-api", "x-db"], "more"))
    const list = setupList()
    await list.refresh() // truncated: a continue token remains
    expect(list.hasNextPage.value).toBe(true)
    const callsAfterRefresh = mockedWalk.mock.calls.length

    await list.searchAllByName("api")
    expect(mockedWalk.mock.calls.length).toBeGreaterThan(callsAfterRefresh)
    expect(list.searchQuery.value).toBe("api")
    expect(list.rows.value.every((r) => r.object?.metadata?.name?.includes("api"))).toBe(true)
    list.stopWatch()
  })

  it("matches by name and reports scan counters", async () => {
    mockedWalk.mockImplementation(walkOf(["api-server", "db-1", "cache", "api-worker"], ""))

    const list = setupList()
    await list.searchAllByName("api")

    // Search passes a keepRow matcher and its match cap to the walker.
    expect(mockedWalk.mock.calls[0]?.[1]).toMatchObject({ maxPages: 20, maxRows: 1000 })
    expect(list.rows.value.map((r) => r.object?.metadata?.name)).toEqual([
      "api-server",
      "api-worker",
    ])
    expect(list.searchQuery.value).toBe("api")
    expect(list.searchScanned.value).toBe(4)
    expect(list.searchTruncated.value).toBe(false)
    expect(list.hasNextPage.value).toBe(false)
  })

  it("matches case-insensitively", async () => {
    mockedWalk.mockImplementation(walkOf(["API-Server", "other"], ""))
    const list = setupList()
    await list.searchAllByName("api")
    expect(list.rows.value).toHaveLength(1)
  })

  it("flags truncation when the scan limit is reached", async () => {
    mockedWalk.mockImplementation(walkOf(["x-1", "x-2"], "more"))
    const list = setupList()
    await list.searchAllByName("nothing-matches")
    expect(list.searchTruncated.value).toBe(true)
    expect(list.rows.value).toHaveLength(0)
  })

  it("refresh() clears search mode", async () => {
    mockedWalk.mockImplementation(walkOf(["api-server"], ""))
    const list = setupList()
    await list.searchAllByName("api")
    expect(list.searchQuery.value).toBe("api")

    mockedWalk.mockImplementation(walkOf(["api-server", "db-1"], ""))
    await list.refresh()
    expect(list.searchQuery.value).toBeNull()
    expect(list.rows.value).toHaveLength(2)
    list.stopWatch()
  })

  it("empty query behaves like refresh", async () => {
    mockedWalk.mockImplementation(walkOf(["a", "b"], ""))
    const list = setupList()
    await list.searchAllByName("   ")
    expect(list.searchQuery.value).toBeNull()
    expect(list.rows.value).toHaveLength(2)
    list.stopWatch()
  })
})

describe("useResourceList watch upserts", () => {
  beforeEach(() => {
    // Sessions (and with them the active context) live in sessionStorage, which
    // outlives a pinia reset: without this, a context another test signed into
    // is already active here and the switch below is a no-op.
    window.sessionStorage.clear()
    setActivePinia(createPinia())
    mockedWalk.mockReset()
    watchFake.onEvent = undefined
  })

  /** row(name) with an extra cell, so an update is observable by key alone. */
  function updated(name: string, mark: string): K8sTableRow {
    return { cells: [name, mark], object: { metadata: { name, uid: `uid-${name}` } } }
  }

  it("replaces a row in place, appends a new one and drops a removed one", async () => {
    mockedWalk.mockImplementation(walkOf(["a", "b", "c"], ""))
    const list = setupList()
    await list.refresh()

    emitEvent("MODIFIED", [updated("b", "modified")])
    expect(names(list.rows.value)).toEqual(["a", "b", "c"]) // position kept
    expect(list.rows.value[1]?.cells).toEqual(["b", "modified"])

    emitEvent("ADDED", [row("d")])
    expect(names(list.rows.value)).toEqual(["a", "b", "c", "d"])

    emitEvent("DELETED", [row("a")])
    expect(names(list.rows.value)).toEqual(["b", "c", "d"])
  })

  it("indexes a row an ADDED event appended, so a later update replaces it", async () => {
    mockedWalk.mockImplementation(walkOf(["a", "b"], ""))
    const list = setupList()
    await list.refresh()

    emitEvent("ADDED", [row("c")])
    emitEvent("MODIFIED", [updated("c", "modified")])
    expect(names(list.rows.value)).toEqual(["a", "b", "c"]) // not appended twice
    expect(list.rows.value[2]?.cells).toEqual(["c", "modified"])
  })

  it("reindexes after a removal so a later event lands on the shifted row", async () => {
    mockedWalk.mockImplementation(walkOf(["a", "b", "c"], ""))
    const list = setupList()
    await list.refresh()

    emitEvent("DELETED", [row("a")]) // every surviving position shifts down
    emitEvent("MODIFIED", [updated("c", "modified")])
    expect(names(list.rows.value)).toEqual(["b", "c"])
    expect(list.rows.value[1]?.cells).toEqual(["c", "modified"])
  })

  // The regression this guards: the key→index map was rebuilt per event, so
  // absorbing one changed row ran rowKey() over the whole collection (5000 rows
  // at the cap) while a rollout emits dozens of events per second.
  it("absorbs one event without re-keying the whole collection", async () => {
    let uidReads = 0
    function counted(name: string, mark?: string): K8sTableRow {
      const metadata: K8sObjectMeta = {
        name,
        get uid() {
          uidReads += 1
          return `uid-${name}`
        },
      }
      return { cells: mark === undefined ? [name] : [name, mark], object: { metadata } }
    }

    const collection = Array.from({ length: 300 }, (_, i) => counted(`pod-${i}`))
    mockedWalk.mockImplementation(async () => ({
      columnDefinitions: [{ name: "Name", type: "string" }],
      rows: collection,
      fallback: false,
      resourceVersion: "1",
      continueToken: "",
      truncated: false,
      scanned: collection.length,
    }))
    const list = setupList()
    await list.refresh()
    expect(list.rows.value).toHaveLength(300)

    uidReads = 0
    emitEvent("MODIFIED", [counted("pod-7", "modified")])

    // rowKey() reads uid twice (once to test it, once to return it), so an event
    // pays for the rows it carries — never for the collection they land in.
    expect(uidReads).toBeLessThanOrEqual(4)
    expect(list.rows.value).toHaveLength(300)
    expect(list.rows.value[7]?.cells).toEqual(["pod-7", "modified"])
  })

  it("does not let the previous cluster's index misplace an event", async () => {
    // "shared" sits last in cluster A and first in cluster B: an index carried
    // across the switch would write the update past the end of the new list.
    mockedWalk.mockImplementation(walkOf(["a", "b", "shared"], ""))
    const list = setupList()
    await list.refresh()
    expect(names(list.rows.value)).toEqual(["a", "b", "shared"])

    mockedWalk.mockImplementation(walkOf(["shared", "z"], ""))
    useAuthStore().setSession("beta", "tok-b", null, false)
    await new Promise((r) => setTimeout(r, 0)) // let the context watch refresh
    expect(names(list.rows.value)).toEqual(["shared", "z"])

    emitEvent("MODIFIED", [updated("shared", "from-beta")])
    expect(names(list.rows.value)).toEqual(["shared", "z"])
    expect(list.rows.value[0]?.cells).toEqual(["shared", "from-beta"])
  })

  it("does not let a stale index survive a resource-type / namespace switch", async () => {
    let ref_: ResourceRef = podsRef
    let namespace: string | undefined = "team-a"
    const list = setupList(
      () => ref_,
      () => ({ namespace, pageSize: 50 }),
    )
    mockedWalk.mockImplementation(walkOf(["a", "b", "shared"], ""))
    await list.refresh()

    // Exactly what ResourceListPage's watch does on a sidebar navigation or a
    // namespace change: swap the target, then refresh.
    ref_ = { group: "apps", version: "v1", resource: "deployments" }
    namespace = undefined
    mockedWalk.mockImplementation(walkOf(["shared", "z"], ""))
    await list.refresh()
    expect(names(list.rows.value)).toEqual(["shared", "z"])

    emitEvent("MODIFIED", [updated("shared", "after-switch")])
    expect(names(list.rows.value)).toEqual(["shared", "z"])
    expect(list.rows.value[0]?.cells).toEqual(["shared", "after-switch"])
  })

  it("hands the table a new array identity on every event", async () => {
    mockedWalk.mockImplementation(walkOf(["a", "b"], ""))
    const list = setupList()
    await list.refresh()

    // Load-bearing: ResourceTable's memos hang off the data array's identity,
    // so an in-place mutation would leave stale cells on screen.
    const before = list.rows.value
    emitEvent("MODIFIED", [updated("a", "modified")])
    expect(list.rows.value).not.toBe(before)
    emitEvent("DELETED", [row("b")])
    expect(list.rows.value).not.toBe(before)
  })
})
