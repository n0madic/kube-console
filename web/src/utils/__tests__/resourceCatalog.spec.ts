import { describe, expect, it } from "vitest"

import type { DiscoveryResource } from "@/api/types"
import { buildCatalog } from "@/utils/resourceCatalog"

function res(partial: Partial<DiscoveryResource> & Pick<DiscoveryResource, "group" | "version" | "resource" | "kind">): DiscoveryResource {
  return {
    id: `${partial.group === "" ? "core" : partial.group}/${partial.version}/${partial.resource}`,
    namespaced: true,
    verbs: ["get", "list", "watch"],
    ...partial,
  }
}

describe("buildCatalog", () => {
  it("hides the events.k8s.io mirror when core events exist", () => {
    const catalog = buildCatalog([
      res({ group: "", version: "v1", resource: "events", kind: "Event" }),
      res({ group: "events.k8s.io", version: "v1", resource: "events", kind: "Event" }),
    ])
    const all = catalog.flatMap((s) => s.resources)
    expect(all).toHaveLength(1)
    expect(all[0]?.group).toBe("")
  })

  it("keeps events.k8s.io when core events are absent", () => {
    const catalog = buildCatalog([
      res({ group: "events.k8s.io", version: "v1", resource: "events", kind: "Event" }),
    ])
    const all = catalog.flatMap((s) => s.resources)
    expect(all).toHaveLength(1)
    expect(all[0]?.group).toBe("events.k8s.io")
  })

  it("dedupes multiple versions keeping the newest", () => {
    const catalog = buildCatalog([
      res({ group: "autoscaling", version: "v1", resource: "horizontalpodautoscalers", kind: "HorizontalPodAutoscaler" }),
      res({ group: "autoscaling", version: "v2", resource: "horizontalpodautoscalers", kind: "HorizontalPodAutoscaler" }),
    ])
    const all = catalog.flatMap((s) => s.resources)
    expect(all).toHaveLength(1)
    expect(all[0]?.version).toBe("v2")
  })

  it("drops non-listable resources", () => {
    const catalog = buildCatalog([
      res({ group: "", version: "v1", resource: "bindings", kind: "Binding", verbs: ["create"] }),
    ])
    expect(catalog.flatMap((s) => s.resources)).toHaveLength(0)
  })

  // Regression: a nonstandard aggregated API can omit verbs in discovery
  // ("verbs": null after Go marshaling) — this crashed the whole sidebar.
  it("tolerates entries without verbs and treats them as non-listable", () => {
    const noVerbs = buildCatalog([
      res({ group: "x.example.com", version: "v1", resource: "things", kind: "Thing", verbs: null }),
      res({ group: "", version: "v1", resource: "pods", kind: "Pod" }),
    ])
    const all = noVerbs.flatMap((s) => s.resources)
    expect(all).toHaveLength(1)
    expect(all[0]?.resource).toBe("pods")
  })
})
