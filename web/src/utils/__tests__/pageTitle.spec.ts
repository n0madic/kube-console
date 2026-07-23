import { describe, expect, it } from "vitest"

import { BASE_TITLE, clusterLabel, pageTitle } from "@/utils/pageTitle"

describe("clusterLabel", () => {
  it("uses the active context name", () => {
    expect(clusterLabel(undefined, "prod-eks")).toBe("prod-eks")
  })

  it("drops context names that identify no cluster", () => {
    for (const generic of [
      "default",
      "kubernetes",
      "kubernetes-admin@kubernetes",
      "Kubernetes-Admin@Kubernetes",
      "  default  ",
      "",
    ]) {
      expect(clusterLabel(undefined, generic)).toBe("")
    }
  })

  it("keeps names that merely contain a generic word", () => {
    expect(clusterLabel(undefined, "kubernetes-admin@prod")).toBe("kubernetes-admin@prod")
    expect(clusterLabel(undefined, "default-eu")).toBe("default-eu")
  })

  it("prefers the configured cluster name over any context", () => {
    expect(clusterLabel("Prod EU", "staging")).toBe("Prod EU")
  })

  it("applies the configured name where the context is generic too", () => {
    // The in-cluster case this exists for: one synthesized "default" context.
    expect(clusterLabel("Prod EU", "default")).toBe("Prod EU")
  })

  it("falls back to the context when the configured name is blank", () => {
    expect(clusterLabel("", "prod-eks")).toBe("prod-eks")
    expect(clusterLabel("   ", "prod-eks")).toBe("prod-eks")
  })
})

describe("pageTitle", () => {
  it("prefixes the base title with the cluster", () => {
    expect(pageTitle(undefined, "prod-eks")).toBe(`prod-eks · ${BASE_TITLE}`)
  })

  it("stays bare when there is nothing worth naming", () => {
    expect(pageTitle(undefined, "default")).toBe(BASE_TITLE)
    expect(pageTitle(undefined, "")).toBe(BASE_TITLE)
  })
})
