// Controllable matchMedia stub for the responsive layout specs.
//
// `ui.narrowViewport` is derived from matchMedia and readonly, so a test must
// drive the media query itself rather than assign the flag — assigning it would
// have left every drawer/overlay spec green even if the listener wiring broke.
// The store reads matchMedia when it is created, so install this BEFORE the
// first useUiStore()/mount of the test.

import { SIDEBAR_NARROW_QUERY } from "@/stores/ui"

export interface ViewportStub {
  /** Cross the breakpoint, emitting the change event the store listens for. */
  set(narrow: boolean): void
  restore(): void
}

export function stubViewport(narrow = false): ViewportStub {
  const original = window.matchMedia
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  let matches = narrow

  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({
      get matches() {
        return query === SIDEBAR_NARROW_QUERY ? matches : false
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
    set(value: boolean) {
      matches = value
      for (const cb of listeners) cb({ matches: value } as MediaQueryListEvent)
    },
    restore() {
      Object.defineProperty(window, "matchMedia", { value: original, configurable: true })
    },
  }
}
