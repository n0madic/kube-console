// The selected namespace is persisted per tab (sessionStorage) so a reload
// keeps it, but only there — never localStorage, and sidebarSearch stays
// transient.

import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it } from "vitest"
import { nextTick } from "vue"

import { NAMESPACE_STORAGE_KEY, useUiStore } from "@/stores/ui"

describe("ui store namespace persistence", () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    setActivePinia(createPinia())
  })

  it("mirrors the selected namespace into sessionStorage", async () => {
    const ui = useUiStore()
    ui.namespace = "prod"
    await nextTick()
    expect(window.sessionStorage.getItem(NAMESPACE_STORAGE_KEY)).toBe("prod")
    expect(window.localStorage.getItem(NAMESPACE_STORAGE_KEY)).toBeNull()
  })

  it("restores the namespace after a reload (fresh pinia, same sessionStorage)", async () => {
    useUiStore().namespace = "kube-system"
    await nextTick() // let the persistence watcher flush

    // Simulate a page reload: new pinia instance, same sessionStorage.
    setActivePinia(createPinia())
    expect(useUiStore().namespace).toBe("kube-system")
  })

  it("clears the stored key when switching back to all namespaces", async () => {
    const ui = useUiStore()
    ui.namespace = "prod"
    await nextTick()
    ui.namespace = ""
    await nextTick()
    expect(window.sessionStorage.getItem(NAMESPACE_STORAGE_KEY)).toBeNull()

    // A reload now lands on all namespaces again.
    setActivePinia(createPinia())
    expect(useUiStore().namespace).toBe("")
  })

  it("defaults to all namespaces when nothing is stored", () => {
    expect(useUiStore().namespace).toBe("")
  })
})
