import { describe, expect, it } from "vitest"

import { isDNS1123Label } from "@/utils/k8sNames"
import { listQuery, parseListQuery, sameQuery } from "@/utils/listQuery"

describe("parseListQuery", () => {
  it("reads an empty query as no namespace and no filters", () => {
    expect(parseListQuery({})).toEqual({ namespace: "", filter: "", labelSelector: "" })
  })

  it("reads every parameter", () => {
    expect(
      parseListQuery({ namespace: "team-a", filter: "api", selector: "app=web,tier!=cache" }),
    ).toEqual({ namespace: "team-a", filter: "api", labelSelector: "app=web,tier!=cache" })
  })

  // The value comes from a link anyone can write and is persisted as the
  // selected namespace, so anything that cannot name a namespace reads as none.
  it.each(["../kube-system", "Team-A", "a_b", "_all", "a/b", "-a", "a".repeat(64)])(
    "ignores the invalid namespace %j",
    (namespace) => {
      expect(parseListQuery({ namespace }).namespace).toBe("")
    },
  )

  it("takes the first of repeated parameters and ignores valueless ones", () => {
    expect(parseListQuery({ namespace: ["b", "c"], filter: null, selector: [null, "x"] })).toEqual({
      namespace: "b",
      filter: "",
      labelSelector: "",
    })
  })
})

describe("listQuery", () => {
  // Defaults never reach the URL: an unfiltered list keeps a bare one.
  it("omits every default", () => {
    expect(listQuery({ namespace: "", filter: "", labelSelector: "" })).toEqual({})
  })

  it("round-trips through parseListQuery", () => {
    for (const state of [
      { namespace: "team-a", filter: "api web", labelSelector: "app in (a,b)" },
      { namespace: "", filter: "x", labelSelector: "" },
      { namespace: "", filter: "", labelSelector: "env=prod" },
    ]) {
      expect(parseListQuery(listQuery(state))).toEqual(state)
    }
  })
})

describe("sameQuery", () => {
  it("matches identical queries regardless of key order", () => {
    expect(sameQuery({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true)
  })

  it("rejects a differing value, a missing key or an extra key", () => {
    expect(sameQuery({ a: "1" }, { a: "2" })).toBe(false)
    expect(sameQuery({ a: "1", b: "2" }, { a: "1" })).toBe(false)
    expect(sameQuery({ a: "1" }, { a: "1", redirect: "/x" })).toBe(false)
    expect(sameQuery({ a: "1" }, { a: ["1"] })).toBe(false)
  })
})

describe("isDNS1123Label", () => {
  it("accepts namespace-shaped names up to 63 characters", () => {
    for (const name of ["a", "kube-system", "team-1", "a".repeat(63)]) {
      expect(isDNS1123Label(name)).toBe(true)
    }
  })

  it("rejects everything else", () => {
    for (const name of ["", "A", "a.b", "a_b", "-a", "a-", "a".repeat(64)]) {
      expect(isDNS1123Label(name)).toBe(false)
    }
  })
})
