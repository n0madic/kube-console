import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"

import type { TableWalkOptions, WalkResult } from "@/api/k8s"
import type { K8sTableRow, ResourceRef } from "@/api/types"

vi.mock("@/api/k8s", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/k8s")>()
  return { ...actual, walkTable: vi.fn() }
})

import { walkTable } from "@/api/k8s"
import { useResourceList } from "@/composables/useResourceList"
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

function setupList() {
  let list!: ReturnType<typeof useResourceList>
  const Host = defineComponent({
    setup() {
      list = useResourceList(
        () => podsRef,
        () => ({ pageSize: 50 }),
      )
      return () => h("div")
    },
  })
  mount(Host)
  return list
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
