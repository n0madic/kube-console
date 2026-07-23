import { describe, expect, it } from "vitest"

import { parseCommandLine } from "@/utils/podHelpers"
import {
  AUTO_PRESET,
  AUTO_PRESET_ID,
  COMMAND_SUGGESTIONS,
  DEFAULT_COMMAND_LINE,
  SHELL_PRESETS,
  isAutoCommand,
} from "@/utils/shellPresets"

// Mirrors internal/exec/protocol.go: an auth frame carrying more than this is
// rejected before the exec is attempted.
const MAX_COMMAND_ARGS = 32
const MAX_ARG_BYTES = 4 << 10

describe("SHELL_PRESETS", () => {
  it("has unique ids", () => {
    const ids = SHELL_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("offers Auto first, so the default needs no picking", () => {
    expect(SHELL_PRESETS[0]?.id).toBe(AUTO_PRESET_ID)
    expect(AUTO_PRESET.id).toBe(AUTO_PRESET_ID)
  })

  it("stays inside the backend's argv limits", () => {
    const encoder = new TextEncoder()
    for (const preset of SHELL_PRESETS) {
      expect(preset.argv.length, preset.id).toBeGreaterThan(0)
      expect(preset.argv.length, preset.id).toBeLessThanOrEqual(MAX_COMMAND_ARGS)
      for (const arg of preset.argv) {
        expect(encoder.encode(arg).length, `${preset.id}: ${arg}`).toBeLessThanOrEqual(MAX_ARG_BYTES)
      }
    }
  })
})

describe("the auto preset", () => {
  const script = AUTO_PRESET.argv[2]!

  it("runs one sh -c that resolves the shell in the container", () => {
    expect(AUTO_PRESET.argv.slice(0, 2)).toEqual(["/bin/sh", "-c"])
    expect(AUTO_PRESET.argv).toHaveLength(3)
  })

  // Regression guard for the POSIX rule that a non-interactive shell exits when
  // exec cannot find its command: `exec bash || exec sh` never reaches the sh.
  it("probes bash before exec'ing it, and never chains exec with ||", () => {
    expect(script).toContain("command -v bash")
    expect(script).not.toContain("||")
    expect(script).toContain("exec sh")
  })

  it("sets TERM, since exec passes no environment and xterm.js is an xterm", () => {
    expect(script).toContain("TERM=xterm-256color")
  })
})

describe("COMMAND_SUGGESTIONS", () => {
  // The combobox is editable: what it shows is what gets parsed back into the
  // argv, so every suggestion must survive that round trip.
  it("renders every preset as a command line parsing back to its argv", () => {
    expect(COMMAND_SUGGESTIONS).toHaveLength(SHELL_PRESETS.length)
    COMMAND_SUGGESTIONS.forEach((suggestion, i) => {
      const preset = SHELL_PRESETS[i]!
      expect(suggestion.label).toBe(preset.label)
      expect(parseCommandLine(suggestion.value), suggestion.value).toEqual(preset.argv)
    })
  })

  it("starts the field on the auto command", () => {
    expect(parseCommandLine(DEFAULT_COMMAND_LINE)).toEqual(AUTO_PRESET.argv)
  })
})

describe("isAutoCommand", () => {
  it("matches the auto argv however it was typed", () => {
    expect(isAutoCommand(AUTO_PRESET.argv)).toBe(true)
    expect(isAutoCommand(parseCommandLine(`  ${DEFAULT_COMMAND_LINE}  `))).toBe(true)
  })

  it("rejects any other command", () => {
    expect(isAutoCommand(["/bin/bash"])).toBe(false)
    expect(isAutoCommand(AUTO_PRESET.argv.slice(0, 2))).toBe(false)
    expect(isAutoCommand(["/bin/sh", "-c", "exec zsh"])).toBe(false)
  })
})
