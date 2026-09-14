import { describe, expect, it } from "vitest"

// Form controls get their focus mark from the one unlayered rule in
// style.css (outline off, blue border). Per-element `focus:` utilities are
// what that rule replaced: they were on two inputs and forgotten on every
// other one, so the UA focus ring kept coming back with each new control.
// jsdom computes no cascade, so this pins the decision the way TopBar.spec
// pins its own: by the classes — no component may carry a local copy of the
// rule. (The stylesheet itself is not asserted on: vitest hands every `.css`
// import, `?raw` included, to its own CSS handling, which yields "", and the
// tsconfig has no node types to read it off disk — its absence is a visible
// regression on every page anyway; the copies are what crept back unseen.)
const sources = import.meta.glob<string>("/src/**/*.vue", {
  query: "?raw",
  import: "default",
  eager: true,
})

describe("focus styling", () => {
  it("is owned by the global rule, never by per-element utilities", () => {
    // A glob matching nothing would make the offenders check vacuous.
    expect(Object.keys(sources).length).toBeGreaterThan(10)
    const offenders = Object.entries(sources)
      .filter(([, src]) => /\bfocus:(border-|outline-)/.test(src))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })
})
