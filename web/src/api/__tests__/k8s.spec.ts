import { afterEach, describe, expect, it, vi } from "vitest"

import {
  deleteObject,
  listAsTable,
  logsUrl,
  resourcePath,
  serverSideApply,
  walkTable,
  watchUrl,
} from "@/api/k8s"
import { setCredentialProvider } from "@/api/http"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function stubFetch(body: unknown) {
  const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse(200, body),
  )
  vi.stubGlobal("fetch", mock)
  setCredentialProvider({
    async getBearerToken() {
      return "tok"
    },
    getContext() {
      return null
    },
    async logout() {},
  })
  return mock
}

afterEach(() => {
  setCredentialProvider(null)
  vi.unstubAllGlobals()
})

describe("resourcePath", () => {
  it("maps the core group to /k8s/api", () => {
    expect(resourcePath({ group: "", version: "v1", resource: "pods" })).toBe("/k8s/api/v1/pods")
    expect(resourcePath({ group: "core", version: "v1", resource: "pods" })).toBe(
      "/k8s/api/v1/pods",
    )
  })

  it("maps named groups to /k8s/apis", () => {
    expect(resourcePath({ group: "apps", version: "v1", resource: "deployments" })).toBe(
      "/k8s/apis/apps/v1/deployments",
    )
  })

  it("adds namespace, name and subresource segments", () => {
    expect(
      resourcePath(
        { group: "", version: "v1", resource: "pods" },
        { namespace: "prod", name: "api-1", subresource: "log" },
      ),
    ).toBe("/k8s/api/v1/namespaces/prod/pods/api-1/log")
  })
})

describe("listAsTable", () => {
  it("passes Table Accept and pagination params, returns native Table", async () => {
    const mock = stubFetch({
      kind: "Table",
      metadata: { resourceVersion: "42", continue: "next-token" },
      columnDefinitions: [{ name: "Name", type: "string" }],
      rows: [{ cells: ["a"] }],
    })
    const result = await listAsTable(
      { group: "apps", version: "v1", resource: "deployments" },
      { namespace: "prod", limit: 50, labelSelector: "app=x" },
    )
    const url = mock.mock.calls[0]?.[0] as string
    expect(url).toContain("/k8s/apis/apps/v1/namespaces/prod/deployments?")
    expect(url).toContain("includeObject=Metadata")
    expect(url).toContain("limit=50")
    expect(url).toContain("labelSelector=app%3Dx")
    const init = mock.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get("Accept")).toContain("as=Table")
    expect(result.fallback).toBe(false)
    expect(result.resourceVersion).toBe("42")
    expect(result.continueToken).toBe("next-token")
  })

  it("falls back to converting a plain List", async () => {
    stubFetch({
      kind: "PodList",
      metadata: { resourceVersion: "7" },
      items: [
        {
          metadata: { name: "api-1", namespace: "prod", creationTimestamp: "2026-07-19T10:00:00Z" },
          status: { phase: "Running" },
        },
      ],
    })
    const result = await listAsTable({ group: "", version: "v1", resource: "pods" })
    expect(result.fallback).toBe(true)
    expect(result.table.columnDefinitions.map((c) => c.name)).toEqual([
      "Name",
      "Namespace",
      "Created",
      "Status",
    ])
    expect(result.table.rows?.[0]?.cells).toEqual([
      "api-1",
      "prod",
      "2026-07-19T10:00:00Z",
      "Running",
    ])
    expect(result.resourceVersion).toBe("7")
  })
})

interface StubPage {
  rows: string[]
  continue: string
}

// Stub fetch to serve Table pages keyed by the request's `continue` token, so
// walkTable's real pagination is exercised end to end.
function stubTablePages(pages: Record<string, StubPage>) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const cont = new URL(String(input), "http://x").searchParams.get("continue") ?? ""
    const p = pages[cont]
    if (p === undefined) throw new Error(`no stub page for continue=${JSON.stringify(cont)}`)
    return jsonResponse(200, {
      kind: "Table",
      metadata: { resourceVersion: "1", continue: p.continue },
      columnDefinitions: [{ name: "Name", type: "string" }],
      rows: p.rows.map((n) => ({ cells: [n], object: { metadata: { name: n, uid: `uid-${n}` } } })),
    })
  })
  vi.stubGlobal("fetch", mock)
  setCredentialProvider({
    async getBearerToken() {
      return "tok"
    },
    getContext() {
      return null
    },
    async logout() {},
  })
  return mock
}

function names(result: { rows: Array<{ object?: { metadata?: { name?: string } } }> }): (string | undefined)[] {
  return result.rows.map((r) => r.object?.metadata?.name)
}

const podsRef = { group: "", version: "v1", resource: "pods" } as const

describe("walkTable", () => {
  it("walks continue tokens until the collection ends", async () => {
    const mock = stubTablePages({
      "": { rows: ["a", "b"], continue: "n1" },
      n1: { rows: ["c"], continue: "" },
    })
    const result = await walkTable(podsRef)
    expect(mock).toHaveBeenCalledTimes(2)
    expect(names(result)).toEqual(["a", "b", "c"])
    expect(result.continueToken).toBe("")
    expect(result.truncated).toBe(false)
    expect(result.scanned).toBe(3)
    expect(result.fallback).toBe(false)
    expect(result.columnDefinitions.map((c) => c.name)).toEqual(["Name"])
  })

  it("stops at maxPages and reports the remaining continue token", async () => {
    const mock = stubTablePages({
      "": { rows: ["a"], continue: "more" },
      more: { rows: ["b"], continue: "more" },
    })
    const result = await walkTable(podsRef, { maxPages: 2 })
    expect(mock).toHaveBeenCalledTimes(2)
    expect(result.continueToken).toBe("more")
    expect(result.truncated).toBe(true)
  })

  it("keeps only rows matching keepRow but scans all fetched rows", async () => {
    stubTablePages({ "": { rows: ["api-1", "db", "api-2"], continue: "" } })
    const result = await walkTable(podsRef, {
      keepRow: (r) => (r.object?.metadata?.name ?? "").includes("api"),
    })
    expect(names(result)).toEqual(["api-1", "api-2"])
    expect(result.scanned).toBe(3)
  })

  it("stops once maxRows kept rows are collected", async () => {
    const mock = stubTablePages({
      "": { rows: ["m1", "m2"], continue: "n1" },
      n1: { rows: ["m3"], continue: "" },
    })
    const result = await walkTable(podsRef, { maxRows: 2, limit: 2 })
    // The first page already fills the cap; the walk stops without paging on.
    expect(mock).toHaveBeenCalledTimes(1)
    expect(result.rows).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it("starts from a given continue token", async () => {
    const mock = stubTablePages({ n1: { rows: ["c"], continue: "" } })
    const result = await walkTable(podsRef, { continueToken: "n1" })
    expect(new URL(String(mock.mock.calls[0]?.[0]), "http://x").searchParams.get("continue")).toBe(
      "n1",
    )
    expect(names(result)).toEqual(["c"])
  })

  it("aborts early when shouldAbort returns true", async () => {
    let calls = 0
    const mock = stubTablePages({
      "": { rows: ["a"], continue: "n1" },
      n1: { rows: ["b"], continue: "n2" },
    })
    const result = await walkTable(podsRef, {
      shouldAbort: () => {
        calls += 1
        return calls >= 1 // abort right after the first page
      },
    })
    expect(mock).toHaveBeenCalledTimes(1)
    expect(names(result)).toEqual([]) // aborted before the fetched page was kept
  })

  it("flags fallback when the server returns a plain List", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          kind: "PodList",
          metadata: { resourceVersion: "7" },
          items: [{ metadata: { name: "api-1", namespace: "prod" }, status: { phase: "Running" } }],
        }),
      ),
    )
    setCredentialProvider({
      async getBearerToken() {
        return "tok"
      },
      getContext() {
        return null
      },
      async logout() {},
    })
    const result = await walkTable(podsRef)
    expect(result.fallback).toBe(true)
    expect(result.rows).toHaveLength(1)
  })
})

describe("serverSideApply", () => {
  it("PATCHes apply-patch+yaml with fieldManager=kube-console and force=false", async () => {
    const mock = stubFetch({ kind: "Deployment" })
    await serverSideApply(
      { group: "apps", version: "v1", resource: "deployments" },
      "prod",
      "api",
      "kind: Deployment\n",
    )
    const url = mock.mock.calls[0]?.[0] as string
    const init = mock.mock.calls[0]?.[1] as RequestInit
    expect(url).toContain("/k8s/apis/apps/v1/namespaces/prod/deployments/api?")
    expect(url).toContain("fieldManager=kube-console")
    expect(url).toContain("force=false")
    expect(url).not.toContain("dryRun")
    expect(init.method).toBe("PATCH")
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/apply-patch+yaml")
    expect(init.body).toBe("kind: Deployment\n")
  })

  it("adds dryRun=All when requested", async () => {
    const mock = stubFetch({ kind: "Deployment" })
    await serverSideApply(
      { group: "apps", version: "v1", resource: "deployments" },
      "prod",
      "api",
      "kind: Deployment\n",
      { dryRun: true },
    )
    expect(mock.mock.calls[0]?.[0] as string).toContain("dryRun=All")
  })
})

describe("deleteObject", () => {
  it("issues DELETE on the object path", async () => {
    const mock = stubFetch({ kind: "Status", status: "Success" })
    await deleteObject({ group: "", version: "v1", resource: "configmaps" }, "prod", "cfg")
    expect(mock.mock.calls[0]?.[0]).toBe("/k8s/api/v1/namespaces/prod/configmaps/cfg")
    expect((mock.mock.calls[0]?.[1] as RequestInit).method).toBe("DELETE")
  })
})

describe("url builders", () => {
  it("builds log URLs with options", () => {
    expect(
      logsUrl("prod", "api-1", {
        container: "app",
        tailLines: 500,
        timestamps: true,
        follow: true,
      }),
    ).toBe(
      "/k8s/api/v1/namespaces/prod/pods/api-1/log?container=app&tailLines=500&timestamps=true&follow=true",
    )
  })

  it("builds watch URLs with bookmarks and resourceVersion", () => {
    const url = watchUrl(
      { group: "", version: "v1", resource: "pods" },
      { namespace: "prod", resourceVersion: "42" },
    )
    expect(url).toContain("/k8s/api/v1/namespaces/prod/pods?")
    expect(url).toContain("watch=true")
    expect(url).toContain("allowWatchBookmarks=true")
    expect(url).toContain("resourceVersion=42")
  })
})
