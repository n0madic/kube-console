// Is the UI dark right now? The explicit theme preference when there is one,
// otherwise the OS setting — and reactively so.

import { computed, onScopeDispose, ref, type ComputedRef } from "vue"

import { usePreferencesStore } from "@/stores/preferences"

const DARK_QUERY = "(prefers-color-scheme: dark)"

/**
 * `MediaQueryList.matches` is not a reactive source, so reading it inside a
 * computed pins whatever the OS theme was when that computed first ran. App.vue
 * knew this and kept a `change` listener; CodeMirrorEditor spelled the same rule
 * out again without one, so with the default theme "system" an OS light/dark
 * flip repainted the whole page around an editor still holding the light
 * palette — until the tab was remounted. One composable, so the rule exists once
 * and the listener cannot be forgotten by the next caller.
 *
 * The MediaQueryList is per caller (there are two) rather than a module
 * singleton: a listener bound to the calling scope is dropped with it, and a
 * test can install its own matchMedia stub before mounting.
 */
export function useDarkMode(): ComputedRef<boolean> {
  const prefs = usePreferencesStore()
  const media = window.matchMedia(DARK_QUERY)
  const prefersDark = ref(media.matches)

  function onChange(event: MediaQueryListEvent): void {
    prefersDark.value = event.matches
  }
  media.addEventListener("change", onChange)
  onScopeDispose(() => media.removeEventListener("change", onChange))

  return computed(() => {
    const theme = prefs.prefs.theme
    if (theme === "dark") return true
    if (theme === "light") return false
    return prefersDark.value
  })
}
