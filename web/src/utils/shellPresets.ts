// Command presets for the pod terminal.
//
// A preset carries an **argv**, not a command line: exec takes an argv, and
// the argv is the authority — the command field only ever shows its
// `formatCommandLine` rendering, which `parseCommandLine` reads back
// unchanged.

import { formatCommandLine } from "@/utils/podHelpers"

export interface ShellPreset {
  id: string
  /**
   * Short name of the preset. Every label but the auto one *is* its command
   * line: the combobox shows the label in place of the value while the field
   * is not being edited, and a shell that fits in the field has nothing to
   * gain from an alias.
   */
  label: string
  /** Optional note shown beside the label in the popup only. */
  hint?: string
  argv: string[]
}

export const AUTO_PRESET_ID = "auto"

// The auto preset resolves the shell *inside* the container in a single exec
// rather than connecting, failing and reconnecting: `/bin/sh` exists in every
// image that has any shell at all (on Alpine it is ash), so one `sh -c` can
// hand over to bash when it is there and stay in sh when it is not.
//
// `command -v bash && exec bash; exec sh` rather than `exec bash || exec sh`:
// POSIX has a non-interactive shell exit when `exec` fails to find its
// command, so the `||` branch would never be reached.
//
// TERM is exported because the exec API passes no environment and xterm.js is
// an xterm-256color emulator; without it the container's default (often unset,
// i.e. "dumb") makes vim/htop/less render as garbage.
const AUTO_SCRIPT =
  "export TERM=xterm-256color; command -v bash >/dev/null 2>&1 && exec bash; exec sh"

export const SHELL_PRESETS: ShellPreset[] = [
  {
    id: AUTO_PRESET_ID,
    label: "Auto",
    hint: "bash when present, else sh · TERM=xterm-256color",
    argv: ["/bin/sh", "-c", AUTO_SCRIPT],
  },
  { id: "bash", label: "/bin/bash", argv: ["/bin/bash"] },
  { id: "bash-login", label: "/bin/bash -l", hint: "login shell", argv: ["/bin/bash", "-l"] },
  { id: "sh", label: "/bin/sh", argv: ["/bin/sh"] },
  { id: "ash", label: "/bin/ash", hint: "Alpine, BusyBox", argv: ["/bin/ash"] },
  { id: "zsh", label: "/bin/zsh", argv: ["/bin/zsh"] },
  { id: "busybox", label: "/bin/busybox sh", hint: "static BusyBox", argv: ["/bin/busybox", "sh"] },
]

export const AUTO_PRESET = SHELL_PRESETS.find((p) => p.id === AUTO_PRESET_ID)!

/** Suggestion rows for the command combobox: a label over the command line. */
export const COMMAND_SUGGESTIONS = SHELL_PRESETS.map((preset) => ({
  value: formatCommandLine(preset.argv),
  label: preset.label,
  ...(preset.hint !== undefined ? { hint: preset.hint } : {}),
}))

/** The command line the terminal starts with. */
export const DEFAULT_COMMAND_LINE = formatCommandLine(AUTO_PRESET.argv)

/**
 * Is this argv the auto shell? Compared as an argv, not as text, so an edited
 * but equivalent command line still counts.
 */
export function isAutoCommand(argv: string[]): boolean {
  return (
    argv.length === AUTO_PRESET.argv.length && argv.every((arg, i) => arg === AUTO_PRESET.argv[i])
  )
}
