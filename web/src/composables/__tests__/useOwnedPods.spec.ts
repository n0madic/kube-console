import { flushPromises } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { effectScope, shallowRef, type EffectScope } from "vue"

import { ApiError } from "@/api/http"

vi.mock("@/api/ownedPods", () => ({ resolveOwnedPods: vi.fn() }))

import { resolveOwnedPods, type OwnedPods } from "@/api/ownedPods"
import type { K8sObject } from "@/api/types"
import { useOwnedPods } from "@/composables/useOwnedPods"

const mockedResolve = vi.mocked(resolveOwnedPods)

function deployment(uid: string, replicas = 1): K8sObject {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace: "prod", uid },
    spec: { replicas },
  }
}

function owned(...names: string[]): OwnedPods {
  return {
    pods: {
      kind: "Table",
      columnDefinitions: [{ name: "Name", type: "string" }],
      rows: names.map((name) => ({ cells: [name], object: { metadata: { name } } })),
    },
    truncated: false,
  }
}

/** A resolver whose outcome the test settles by hand, in whatever order it wants. */
function deferred() {
  let resolve!: (r: OwnedPods | null) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<OwnedPods | null>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("useOwnedPods", () => {
  let scope: EffectScope
  // The getter has to read reactive state or the identity watch never fires;
  // the scope stops the watcher between tests.
  const object = shallowRef<K8sObject | null>(null)

  function setup() {
    scope = effectScope()
    return scope.run(() => useOwnedPods(() => object.value))!
  }

  beforeEach(() => {
    mockedResolve.mockReset()
    object.value = null
  })
  afterEach(() => {
    scope.stop()
  })

  it("resolves on mount and on every new object identity", async () => {
    object.value = deployment("d1")
    mockedResolve.mockResolvedValue(owned("web-1"))
    const { state } = setup()
    expect(state.value.loading).toBe(true)
    await flushPromises()
    expect(state.value).toEqual({ loading: false, error: null, result: owned("web-1") })

    mockedResolve.mockResolvedValue(owned("web-2"))
    object.value = deployment("d1", 2)
    await flushPromises()
    expect(mockedResolve).toHaveBeenCalledTimes(2)
    expect(state.value.result).toEqual(owned("web-2"))
  })

  // Regression guard for the page's tab watch: the Logs tab exists only while
  // a result with pods is held, and the page bounces to Overview the moment it
  // is gone — so a Refresh of the same object must not blank it.
  it("keeps the previous result while the same object reloads", async () => {
    object.value = deployment("d1")
    mockedResolve.mockResolvedValue(owned("web-1"))
    const { state } = setup()
    await flushPromises()

    const d = deferred()
    mockedResolve.mockReturnValue(d.promise)
    object.value = deployment("d1", 2)
    await flushPromises()
    expect(state.value.loading).toBe(true)
    expect(state.value.result).toEqual(owned("web-1"))

    d.resolve(owned("web-1", "web-2"))
    await flushPromises()
    expect(state.value).toEqual({ loading: false, error: null, result: owned("web-1", "web-2") })
  })

  it("keeps the previous result and reports the error when the same object fails to reload", async () => {
    object.value = deployment("d1")
    mockedResolve.mockResolvedValue(owned("web-1"))
    const { state } = setup()
    await flushPromises()

    mockedResolve.mockRejectedValue(new ApiError(500, "boom"))
    object.value = deployment("d1", 2)
    await flushPromises()
    expect(state.value).toEqual({ loading: false, error: "boom", result: owned("web-1") })
  })

  it("clears the result at once for another object, and for none", async () => {
    object.value = deployment("d1")
    mockedResolve.mockResolvedValue(owned("web-1"))
    const { state } = setup()
    await flushPromises()

    const d = deferred()
    mockedResolve.mockReturnValue(d.promise)
    object.value = deployment("d2")
    await flushPromises()
    expect(state.value).toEqual({ loading: true, error: null, result: null })
    d.resolve(owned("other-1"))
    await flushPromises()
    expect(state.value.result).toEqual(owned("other-1"))

    object.value = null
    await flushPromises()
    expect(state.value).toEqual({ loading: false, error: null, result: null })
    expect(mockedResolve).toHaveBeenCalledTimes(2)
  })

  // A failed load of a *different* object keeps nothing either: its
  // predecessor's pods under the new header would be a lie.
  it("holds no stale result when a different object fails", async () => {
    object.value = deployment("d1")
    mockedResolve.mockResolvedValue(owned("web-1"))
    const { state } = setup()
    await flushPromises()

    mockedResolve.mockRejectedValue(new ApiError(403, "forbidden"))
    object.value = deployment("d2")
    await flushPromises()
    expect(state.value).toEqual({ loading: false, error: "forbidden", result: null })
  })

  it("discards a stale response that lands after a newer object's", async () => {
    const first = deferred()
    mockedResolve.mockReturnValueOnce(first.promise)
    object.value = deployment("d1")
    const { state } = setup()
    await flushPromises()

    mockedResolve.mockResolvedValueOnce(owned("d2-pod"))
    object.value = deployment("d2")
    await flushPromises()
    expect(state.value.result).toEqual(owned("d2-pod"))

    first.resolve(owned("d1-pod"))
    await flushPromises()
    expect(state.value.result).toEqual(owned("d2-pod"))
    expect(state.value.loading).toBe(false)
  })

  it("does not resolve kinds outside the registry", async () => {
    object.value = { apiVersion: "v1", kind: "Pod", metadata: { name: "p", uid: "u" } }
    const { state } = setup()
    await flushPromises()
    expect(state.value).toEqual({ loading: false, error: null, result: null })
    expect(mockedResolve).not.toHaveBeenCalled()
  })
})
