import { describe, expect, it } from "vitest"

import { isFindShortcut } from "@/utils/findShortcut"

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init)
}

describe("isFindShortcut", () => {
  it("matches Ctrl+F and Cmd+F on a Latin layout", () => {
    expect(isFindShortcut(key({ key: "f", code: "KeyF", ctrlKey: true }))).toBe(true)
    expect(isFindShortcut(key({ key: "f", code: "KeyF", metaKey: true }))).toBe(true)
    // CapsLock.
    expect(isFindShortcut(key({ key: "F", code: "KeyF", ctrlKey: true }))).toBe(true)
  })

  it("matches by character on a remapped Latin layout", () => {
    // Dvorak: the F is on the physical KeyU.
    expect(isFindShortcut(key({ key: "f", code: "KeyU", ctrlKey: true }))).toBe(true)
    // Colemak: the physical KeyF types "t" — that is Ctrl+T, not Find.
    expect(isFindShortcut(key({ key: "t", code: "KeyF", ctrlKey: true }))).toBe(false)
  })

  it("falls back to the physical key on a non-Latin layout", () => {
    expect(isFindShortcut(key({ key: "а", code: "KeyF", ctrlKey: true }))).toBe(true)
    expect(isFindShortcut(key({ key: "а", code: "KeyA", ctrlKey: true }))).toBe(false)
  })

  it("ignores other modifier combinations", () => {
    expect(isFindShortcut(key({ key: "f", code: "KeyF" }))).toBe(false)
    expect(isFindShortcut(key({ key: "F", code: "KeyF", ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isFindShortcut(key({ key: "f", code: "KeyF", ctrlKey: true, altKey: true }))).toBe(false)
  })
})
