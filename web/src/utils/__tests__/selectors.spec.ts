import { describe, expect, it } from "vitest"

import { selectorToString } from "@/utils/selectors"

describe("selectorToString", () => {
  it("serializes matchLabels", () => {
    expect(selectorToString({ matchLabels: { app: "web", tier: "front" } })).toBe(
      "app=web,tier=front",
    )
  })

  it("serializes matchExpressions", () => {
    expect(
      selectorToString({
        matchExpressions: [
          { key: "env", operator: "In", values: ["prod", "stage"] },
          { key: "tier", operator: "NotIn", values: ["cache"] },
          { key: "app", operator: "Exists" },
          { key: "legacy", operator: "DoesNotExist" },
        ],
      }),
    ).toBe("env in (prod,stage),tier notin (cache),app,!legacy")
  })

  it("combines labels and expressions", () => {
    expect(
      selectorToString({
        matchLabels: { app: "web" },
        matchExpressions: [{ key: "env", operator: "Exists" }],
      }),
    ).toBe("app=web,env")
  })

  it("returns empty string for missing selector", () => {
    expect(selectorToString(undefined)).toBe("")
    expect(selectorToString({})).toBe("")
  })
})
