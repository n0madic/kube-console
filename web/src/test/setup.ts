// Vitest setup. Node >= 22 defines an (unusable) global localStorage that
// shadows jsdom's implementation, so provide an in-memory Storage polyfill.

class MemoryStorage implements Storage {
  private data = new Map<string, string>()

  get length(): number {
    return this.data.size
  }

  clear(): void {
    this.data.clear()
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) as string) : null
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value))
  }
}

if (typeof window !== "undefined" && window.localStorage === undefined) {
  Object.defineProperty(window, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
  })
}

if (typeof window !== "undefined" && window.sessionStorage === undefined) {
  Object.defineProperty(window, "sessionStorage", {
    value: new MemoryStorage(),
    configurable: true,
  })
}

// jsdom lacks matchMedia; uPlot calls it at import time (device pixel ratio),
// so any test whose import graph reaches a chart component needs it.
if (typeof window !== "undefined" && window.matchMedia === undefined) {
  Object.defineProperty(window, "matchMedia", {
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
    configurable: true,
  })
}

// jsdom lacks ResizeObserver (needed by @tanstack/vue-virtual).
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverPolyfill implements ResizeObserver {
    private readonly callback: ResizeObserverCallback

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }

    observe(target: Element): void {
      const rect = target.getBoundingClientRect()
      this.callback(
        [{ target, contentRect: rect } as ResizeObserverEntry],
        this,
      )
    }

    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverPolyfill
}
