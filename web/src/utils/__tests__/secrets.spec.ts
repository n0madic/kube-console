import { describe, expect, it } from "vitest"

import { isMaskedAnnotation, isSecret } from "@/utils/secrets"

describe("isSecret", () => {
  it("matches only the core v1 Secret", () => {
    expect(isSecret({ apiVersion: "v1", kind: "Secret" })).toBe(true)
    expect(isSecret({ apiVersion: "v1", kind: "ConfigMap" })).toBe(false)
    expect(isSecret({ apiVersion: "example.com/v1", kind: "Secret" })).toBe(false)
    expect(isSecret({})).toBe(false)
  })
})

describe("isMaskedAnnotation", () => {
  const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration"

  it("masks last-applied-configuration on a Secret only", () => {
    expect(isMaskedAnnotation({ apiVersion: "v1", kind: "Secret" }, LAST_APPLIED)).toBe(true)
    expect(isMaskedAnnotation({ apiVersion: "v1", kind: "ConfigMap" }, LAST_APPLIED)).toBe(false)
    expect(isMaskedAnnotation({ apiVersion: "v1", kind: "Secret" }, "owner")).toBe(false)
  })
})
