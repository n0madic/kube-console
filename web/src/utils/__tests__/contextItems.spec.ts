import { describe, expect, it } from "vitest"

import { contextItems } from "@/utils/contextItems"

const signedIn = (names: string[]) => (name: string) => names.includes(name)

describe("contextItems", () => {
  // Both pickers must agree on the order even though the login page unions
  // several unordered sources.
  it("sorts by name regardless of the input order", () => {
    expect(contextItems(["staging", "dev", "prod"], signedIn([])).map((i) => i.name)).toEqual([
      "dev",
      "prod",
      "staging",
    ])
  })

  it("dedupes names contributed by more than one source", () => {
    expect(contextItems(["prod", "dev", "prod"], signedIn([])).map((i) => i.name)).toEqual([
      "dev",
      "prod",
    ])
  })

  // The active context is "" before the very first login and must not become a
  // selectable row.
  it("drops empty names", () => {
    expect(contextItems(["", "prod"], signedIn([])).map((i) => i.name)).toEqual(["prod"])
  })

  it("marks the contexts with a live session", () => {
    expect(contextItems(["prod", "dev"], signedIn(["prod"]))).toEqual([
      { name: "dev", signedIn: false },
      { name: "prod", signedIn: true },
    ])
  })
})
