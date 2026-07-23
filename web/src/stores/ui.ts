// UI store: transient view state. The one exception is the selected namespace,
// which is mirrored into sessionStorage (tab-scoped, gone when the tab closes,
// like the auth session) so a page reload keeps the current namespace instead
// of snapping back to "all namespaces". Nothing sensitive is stored here.

import { defineStore } from "pinia"
import { ref, watch } from "vue"

export const NAMESPACE_STORAGE_KEY = "kube-console.namespace.v1"

function readStoredNamespace(): string {
  try {
    return window.sessionStorage.getItem(NAMESPACE_STORAGE_KEY) ?? ""
  } catch {
    return ""
  }
}

function writeStoredNamespace(namespace: string): void {
  try {
    // "" means all namespaces — the default, so drop the key instead of storing
    // an empty value.
    if (namespace === "") window.sessionStorage.removeItem(NAMESPACE_STORAGE_KEY)
    else window.sessionStorage.setItem(NAMESPACE_STORAGE_KEY, namespace)
  } catch {
    // Storage unavailable: the selection simply will not survive a reload.
  }
}

export const useUiStore = defineStore("ui", () => {
  /** Selected namespace; "" means all namespaces. Persisted per tab. */
  const namespace = ref(readStoredNamespace())
  const sidebarSearch = ref("")

  watch(namespace, writeStoredNamespace)

  return { namespace, sidebarSearch }
})
