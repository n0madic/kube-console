import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it } from "vitest"

import { createAppRouter, resourceDetailRoute, resourceListRoute } from "@/router"
import { useAuthStore } from "@/stores/auth"

describe("resource routes", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it("spells the core group as core in list routes", () => {
    const router = createAppRouter()
    const loc = router.resolve(
      resourceListRoute({ group: "", version: "v1", resource: "pods" }),
    )
    expect(loc.path).toBe("/r/core/v1/pods")
  })

  it("builds apps group list routes", () => {
    const router = createAppRouter()
    const loc = router.resolve(
      resourceListRoute({ group: "apps", version: "v1", resource: "deployments" }),
    )
    expect(loc.path).toBe("/r/apps/v1/deployments")
  })

  it("uses the _ sentinel for cluster-scoped detail routes", () => {
    const router = createAppRouter()
    const loc = router.resolve(
      resourceDetailRoute({ group: "", version: "v1", resource: "nodes" }, undefined, "node-1"),
    )
    expect(loc.path).toBe("/r/core/v1/nodes/_/node-1")
  })

  it("keeps real namespaces in detail routes", () => {
    const router = createAppRouter()
    const loc = router.resolve(
      resourceDetailRoute(
        { group: "apps", version: "v1", resource: "deployments" },
        "prod",
        "api",
      ),
    )
    expect(loc.path).toBe("/r/apps/v1/deployments/prod/api")
  })

  it("redirects unauthenticated navigation to login", async () => {
    const router = createAppRouter()
    await router.push("/r/core/v1/pods")
    expect(router.currentRoute.value.name).toBe("login")
    expect(router.currentRoute.value.query.redirect).toBe("/r/core/v1/pods")
  })

  it("lets authenticated users through", async () => {
    const auth = useAuthStore()
    auth.setSession("default", "tok", { username: "jane" }, false)
    const router = createAppRouter()
    await router.push("/r/core/v1/pods")
    expect(router.currentRoute.value.name).toBe("resource-list")
  })
})
