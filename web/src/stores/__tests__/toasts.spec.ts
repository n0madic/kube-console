import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useToastStore } from "@/stores/toasts"

describe("toasts store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("auto-dismisses after the timeout", () => {
    const store = useToastStore()
    store.push("info", "hello", 5000)
    expect(store.toasts).toHaveLength(1)
    vi.advanceTimersByTime(5000)
    expect(store.toasts).toHaveLength(0)
  })

  it("cancels the pending auto-dismiss timer on manual dismiss", () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout")
    const store = useToastStore()
    store.push("info", "hello", 5000)
    const id = store.toasts[0]!.id

    store.dismiss(id)
    expect(store.toasts).toHaveLength(0)
    expect(clearSpy).toHaveBeenCalled()

    // Advancing past the original timeout must not throw or re-dismiss.
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
    expect(store.toasts).toHaveLength(0)
  })
})
