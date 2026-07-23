// findByKind / findByLowerKind gate resolution on `get`: every consumer turns
// the resolved entry into a detail-page RouterLink, and the detail page GETs
// the object. A kind that cannot be fetched must not be linked — but a kind
// that merely omits its verb list (nonstandard aggregated APIs do) must stay
// linkable, or live CRD links would silently disappear.

import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

import type { DiscoveryResource, DiscoveryResponse } from "@/api/types"

const state = vi.hoisted(() => ({ data: undefined as { value: unknown } | undefined }))
vi.mock("@tanstack/vue-query", () => ({
  useQuery: () => ({ data: state.data }),
}))

import { useDiscovery } from "@/composables/useDiscovery"

function res(partial: Partial<DiscoveryResource> & { kind: string }): DiscoveryResource {
  return {
    id: `${partial.group ?? "core"}/${partial.version ?? "v1"}/${partial.resource ?? "x"}`,
    group: "",
    version: "v1",
    resource: partial.kind.toLowerCase() + "s",
    namespaced: true,
    ...partial,
  }
}

function withResources(resources: DiscoveryResource[]): ReturnType<typeof useDiscovery> {
  state.data = ref<DiscoveryResponse | undefined>({ resources })
  return useDiscovery()
}

describe("useDiscovery resolvers", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    state.data = ref<DiscoveryResponse | undefined>(undefined)
  })

  it("findByKind resolves a normal gettable resource", () => {
    const d = withResources([res({ kind: "Pod", verbs: ["get", "list", "watch"] })])
    expect(d.findByKind("v1", "Pod")?.kind).toBe("Pod")
  })

  // Regression: findByKind applied no verb filter, so a create-only review
  // (verbs declared, but no `get`) resolved to a RouterLink that then 405s.
  it("findByKind rejects a resource whose verbs exclude get", () => {
    const d = withResources([
      res({
        group: "authentication.k8s.io",
        kind: "TokenReview",
        resource: "tokenreviews",
        namespaced: false,
        verbs: ["create"],
      }),
    ])
    expect(d.findByKind("authentication.k8s.io/v1", "TokenReview")).toBeUndefined()
  })

  // Regression guard for the fix's own risk: an aggregated API that omits its
  // verb list (backend normalizes to []) must NOT be treated as non-gettable,
  // or every such CRD link vanishes.
  it("findByKind keeps a resource that declares no verbs at all", () => {
    const omitted = withResources([
      res({ group: "example.com", version: "v1", kind: "Widget", resource: "widgets", verbs: [] }),
    ])
    expect(omitted.findByKind("example.com/v1", "Widget")?.kind).toBe("Widget")

    const nullVerbs = withResources([
      res({ group: "example.com", version: "v1", kind: "Widget", resource: "widgets", verbs: null }),
    ])
    expect(nullVerbs.findByKind("example.com/v1", "Widget")?.kind).toBe("Widget")
  })

  it("findByLowerKind applies the same get-or-unknown rule as findByKind", () => {
    const d = withResources([
      res({ group: "example.com", kind: "Widget", resource: "widgets", verbs: [] }),
      res({ group: "other.com", kind: "Widget", resource: "widgets", verbs: ["create"] }),
    ])
    // The verbs-omitted one is linkable; the create-only one is not.
    expect(d.findByLowerKind("widget", "example.com")?.group).toBe("example.com")
    expect(d.findByLowerKind("widget", "other.com")).toBeUndefined()
  })
})
