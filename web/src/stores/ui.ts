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
import { computed, readonly, ref, watch } from "vue"

import { usePreferencesStore } from "./preferences"

export const NAMESPACE_STORAGE_KEY = "kube-console.namespace.v1"

/** Everything below Tailwind's `lg`, written as the **exact complement** of it.
 * Tailwind v4 breakpoints are rem-based (`lg` is `64rem`, emitted as
 * `@media (width >= 64rem)`), so a px query would drift from every `lg:`
 * utility as soon as the root font size is not 16px; and negating with a
 * `max-width` leaves a gap no matter how many nines it carries, since the two
 * bounds cannot meet. `not all and (…)` has neither problem. */
export const SIDEBAR_NARROW_QUERY = "not all and (min-width: 64rem)"

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

  /** One-shot request for the `SidebarToggle` that is about to mount to take
   * the focus. The control moves between the TopBar and the sidebar header, so
   * whatever dismissed the sidebar — its own button, Esc, the backdrop — takes
   * the focused element away with it, and the browser would drop focus on
   * `<body>`. Consumed by the instance mounting in its place, which is the only
   * one that knows it is there. */
  const toggleFocusPending = ref(false)

  function requestToggleFocus(): void {
    toggleFocusPending.value = true
  }

  function consumeToggleFocus(): boolean {
    if (!toggleFocusPending.value) return false
    toggleFocusPending.value = false
    return true
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
    requestToggleFocus()
  }

  /**
   * No-op on a wide viewport: navigation and Esc must not collapse the in-flow
   * sidebar, only dismiss the drawer overlaying the content.
   *
   * `returnFocus` is what the caller knows and this cannot: a dismissal (Esc,
   * the backdrop) leaves the user where they were, so the focus the vanishing
   * drawer held has to be caught, while **navigation** hands them new content
   * whose start is where the focus belongs — pulling it onto the hamburger
   * instead would be a jump backwards on every link. The request is made only
   * when something actually closed, so a route change on a wide viewport (this
   * runs on every one) never moves the focus at all.
   */
  function closeSidebar(returnFocus = true): void {
    if (!drawerOpen.value) return
    drawerOpen.value = false
    if (returnFocus) requestToggleFocus()
  }

  return {
    namespace,
    sidebarSearch,
    // Derived from matchMedia: writable only by the listener above, or a
    // consumer could desync it from the viewport for the rest of the session.
    narrowViewport: readonly(narrowViewport),
    sidebarOpen,
    toggleSidebar,
    closeSidebar,
    consumeToggleFocus,
  }
})
