import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/http"
import type { K8sObject, ResourceRef } from "@/api/types"

vi.mock("@/api/k8s", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/k8s")>()
  return { ...actual, getObject: vi.fn() }
})

import { getObject } from "@/api/k8s"
import { useResourceObject } from "@/composables/useResourceObject"

const mockedGet = vi.mocked(getObject)
const podsRef: ResourceRef = { group: "", version: "v1", resource: "pods" }

// useResourceObject registers no lifecycle hooks, so it can be exercised
// outside a mounted component.
describe("useResourceObject race guard", () => {
  beforeEach(() => {
    mockedGet.mockReset()
  })

  it("ignores a slow stale response when the target changed mid-fetch", async () => {
    const resolvers: Record<string, (o: K8sObject) => void> = {}
    mockedGet.mockImplementation(
      (_r, _n, name) =>
        new Promise<K8sObject>((res) => {
          resolvers[name] = res
        }),
    )

    let target = { ref: podsRef, namespace: "default" as string | undefined, name: "A" }
    const detail = useResourceObject(() => target)

    const p1 = detail.refresh() // fetch A
    target = { ref: podsRef, namespace: "default", name: "B" }
    const p2 = detail.refresh() // fetch B (newer)

    // Newer (B) resolves first, then the stale (A) resolves last.
    resolvers.B?.({ kind: "Pod", metadata: { name: "B" } })
    await p2
    resolvers.A?.({ kind: "Pod", metadata: { name: "A" } })
    await p1

    expect(detail.object.value?.metadata?.name).toBe("B")
    expect(detail.loading.value).toBe(false)
  })
})

describe("useResourceObject error handling", () => {
  beforeEach(() => {
    mockedGet.mockReset()
  })

  // Regression: a transient failure used to null the object, which unmounts the
  // whole detail view — killing a live exec session or log stream with it.
  it("keeps the object when a refresh of the same target fails", async () => {
    const pod: K8sObject = { kind: "Pod", metadata: { name: "A", uid: "u1" } }
    const target = { ref: podsRef, namespace: "default" as string | undefined, name: "A" }
    const detail = useResourceObject(() => target)

    mockedGet.mockResolvedValueOnce(pod)
    await detail.refresh()
    expect(detail.object.value).toBe(pod)

    mockedGet.mockRejectedValueOnce(new ApiError(500, "internal error"))
    await detail.refresh()

    expect(detail.object.value).toBe(pod) // still on screen, tabs stay mounted
    expect(detail.error.value?.status).toBe(500)
    expect(detail.loading.value).toBe(false)
  })

  it("clears the object when a different target fails to load", async () => {
    let target = { ref: podsRef, namespace: "default" as string | undefined, name: "A" }
    const detail = useResourceObject(() => target)

    mockedGet.mockResolvedValueOnce({ kind: "Pod", metadata: { name: "A" } })
    await detail.refresh()

    target = { ref: podsRef, namespace: "default", name: "B" }
    mockedGet.mockRejectedValueOnce(new ApiError(404, "not found"))
    await detail.refresh()

    // Showing A's data under B's header would be a lie.
    expect(detail.object.value).toBeNull()
    expect(detail.error.value?.status).toBe(404)
  })

  it("clears the object when the same name in another namespace fails", async () => {
    let target = { ref: podsRef, namespace: "default" as string | undefined, name: "A" }
    const detail = useResourceObject(() => target)

    mockedGet.mockResolvedValueOnce({ kind: "Pod", metadata: { name: "A", namespace: "default" } })
    await detail.refresh()

    target = { ref: podsRef, namespace: "kube-system", name: "A" }
    mockedGet.mockRejectedValueOnce(new ApiError(403, "forbidden"))
    await detail.refresh()

    expect(detail.object.value).toBeNull()
  })
})
