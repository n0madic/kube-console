// UI store: transient view state. The one exception is the selected namespace,
// which is mirrored into sessionStorage (tab-scoped, gone when the tab closes,
// like the auth session) so a page reload keeps the current namespace instead
// of snapping back to "all namespaces". Nothing sensitive is stored here.
//
// Sidebar visibility is deliberately split in two: the user's choice on a wide
// viewport is a preference (prefs.sidebarCollapsed, localStorage), while the
// narrow-viewport drawer is transient state living only here. Auto-collapsing
// on a narrow screen must never overwrite what was chosen on a wide one.

import { defineStore } from "pinia"
import { computed, ref, watch } from "vue"

import { usePreferencesStore } from "./preferences"

export const NAMESPACE_STORAGE_KEY = "kube-console.namespace.v1"

/** Tailwind's `lg` breakpoint. The fraction matters: between `max-width:
 * 1023px` and `min-width: 1024px` a 1023.5px viewport matches neither. */
export const SIDEBAR_NARROW_QUERY = "(max-width: 1023.98px)"

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

  const prefs = usePreferencesStore()

  const narrowViewport = ref(false)
  // The listener lives as long as the store does (the whole application
  // lifetime), so there is nowhere and no reason to remove it — same as the
  // theme's matchMedia in App.vue.
  const media =
    typeof window.matchMedia === "function" ? window.matchMedia(SIDEBAR_NARROW_QUERY) : null
  if (media !== null) {
    narrowViewport.value = media.matches
    media.addEventListener("change", (e) => {
      narrowViewport.value = e.matches
    })
  }

  /** Transient by design: auto-collapsing must not reach the saved prefs. */
  const drawerOpen = ref(false)
  // Reset on every mode change, so a drawer left open does not spring back the
  // next time the viewport narrows.
  watch(narrowViewport, () => {
    drawerOpen.value = false
  })

  const sidebarOpen = computed(() =>
    narrowViewport.value ? drawerOpen.value : !prefs.prefs.sidebarCollapsed,
  )

  function toggleSidebar(): void {
    if (narrowViewport.value) drawerOpen.value = !drawerOpen.value
    else prefs.prefs.sidebarCollapsed = !prefs.prefs.sidebarCollapsed
  }

  /** No-op on a wide viewport: navigation and Esc must not collapse the
   * in-flow sidebar, only dismiss the drawer overlaying the content. */
  function closeSidebar(): void {
    drawerOpen.value = false
  }

  return { namespace, sidebarSearch, narrowViewport, sidebarOpen, toggleSidebar, closeSidebar }
})
