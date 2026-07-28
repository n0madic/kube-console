import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { defineComponent, h, nextTick, type ComputedRef } from "vue"

import { useDarkMode } from "@/composables/useDarkMode"
import { usePreferencesStore } from "@/stores/preferences"

// The OS theme, driven from the test: matchMedia.matches is not reactive, so a
// stub that only reports a value would leave this spec green even if the
// listener wiring were dropped again.
function stubOsTheme(dark: boolean) {
  const original = window.matchMedia
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  let matches = dark

  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({
      get matches() {
        return query === "(prefers-color-scheme: dark)" ? matches : false
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
        listeners.add(cb)
      },
      removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
        listeners.delete(cb)
      },
      dispatchEvent: () => false,
    }),
    configurable: true,
  })

  return {
    listenerCount: () => listeners.size,
    set(value: boolean) {
      matches = value
      for (const cb of listeners) cb({ matches: value } as MediaQueryListEvent)
    },
    restore() {
      Object.defineProperty(window, "matchMedia", { value: original, configurable: true })
    },
  }
}

function mountDarkMode() {
  let isDark!: ComputedRef<boolean>
  const wrapper = mount(
    defineComponent({
      setup() {
        isDark = useDarkMode()
        return () => h("div")
      },
    }),
  )
  return { wrapper, isDark: () => isDark.value }
}

describe("useDarkMode", () => {
  let os: ReturnType<typeof stubOsTheme>

  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
    os = stubOsTheme(false)
  })
  afterEach(() => os.restore())

  // Regression: the editor read matchMedia inside a computed, so with the
  // default theme ("system") an OS light→dark flip repainted the app while the
  // CodeMirror view kept its light palette until the tab was remounted.
  it("follows an OS theme flip while the preference is 'system'", async () => {
    const { isDark } = mountDarkMode()
    expect(isDark()).toBe(false)

    os.set(true)
    await nextTick()
    expect(isDark()).toBe(true)

    os.set(false)
    await nextTick()
    expect(isDark()).toBe(false)
  })

  it("lets an explicit preference win over the OS, in both directions", async () => {
    const prefs = usePreferencesStore()
    const { isDark } = mountDarkMode()

    prefs.prefs.theme = "dark"
    await nextTick()
    expect(isDark()).toBe(true)
    os.set(false)
    await nextTick()
    expect(isDark()).toBe(true)

    prefs.prefs.theme = "light"
    os.set(true)
    await nextTick()
    expect(isDark()).toBe(false)

    // ...and "system" hands control back to the OS, still live.
    prefs.prefs.theme = "system"
    await nextTick()
    expect(isDark()).toBe(true)
  })

  it("drops its listener with the calling scope", () => {
    const { wrapper } = mountDarkMode()
    expect(os.listenerCount()).toBe(1)
    wrapper.unmount()
    expect(os.listenerCount()).toBe(0)
  })
})
