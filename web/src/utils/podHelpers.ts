// Pod object helpers shared by logs/terminal/metrics tabs.

import type { K8sObject } from "@/api/types"

interface PodSpecLike {
  containers?: Array<{ name?: string }>
  initContainers?: Array<{ name?: string }>
  ephemeralContainers?: Array<{ name?: string }>
}

/** Which section of the pod spec a container comes from. */
export type ContainerKind = "container" | "ephemeral" | "init"

export interface PodContainer {
  name: string
  kind: ContainerKind
}

const DEFAULT_CONTAINER_ANNOTATION = "kubectl.kubernetes.io/default-container"

function named(list: Array<{ name?: string }> | undefined, kind: ContainerKind): PodContainer[] {
  return (list ?? []).map((c) => ({ name: c.name ?? "", kind })).filter((c) => c.name !== "")
}

/**
 * Every container of the pod, in picker order: regular, then ephemeral, then
 * init. Ephemeral ones are `kubectl debug` containers — the usual exec target
 * when the app image has no shell — so they rank above init containers, which
 * come last because exec into a finished init container always fails.
 */
export function podContainers(pod: K8sObject): PodContainer[] {
  const spec = (pod.spec ?? {}) as PodSpecLike
  return [
    ...named(spec.containers, "container"),
    ...named(spec.ephemeralContainers, "ephemeral"),
    ...named(spec.initContainers, "init"),
  ]
}

/**
 * Container to preselect: the `kubectl.kubernetes.io/default-container`
 * annotation when it names one of this pod's containers (kubectl honours it
 * for logs and exec alike, and injected sidecars make the first container the
 * wrong guess often enough), else the first regular container.
 */
export function defaultContainerName(pod: K8sObject): string {
  const all = podContainers(pod)
  const annotated = pod.metadata?.annotations?.[DEFAULT_CONTAINER_ANNOTATION]
  if (annotated !== undefined && all.some((c) => c.name === annotated)) return annotated
  return all.find((c) => c.kind === "container")?.name ?? all[0]?.name ?? ""
}

/**
 * Split a terminal command line into an exec argv.
 *
 * Quoting only — no expansion of any kind: the argv goes to exec, not through
 * a shell, so `$VAR`, globs and `;` are literal text. `'…'` groups literally,
 * `"…"` groups with `\"` and `\\` escapes, and a backslash outside quotes
 * escapes the next character. That is what lets `/bin/sh -c '…'` be typed at
 * all — and it is the round-trip partner of `formatCommandLine`, so the
 * command shown in the field is exactly the argv that will run.
 *
 * An unterminated quote simply ends at the end of the line: this feeds a text
 * field, where a half-typed command is the normal state, not a syntax error.
 */
export function parseCommandLine(line: string): string[] {
  const argv: string[] = []
  let current = ""
  // Tracked separately from `current !== ""`, so an explicitly empty argument
  // (`''`) survives while runs of whitespace still produce nothing.
  let started = false
  let quote: "'" | '"' | null = null

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      continue
    }
    if (quote === '"') {
      if (ch === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) current += line[++i]!
      else if (ch === '"') quote = null
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
    } else if (ch === "\\" && i + 1 < line.length) {
      current += line[++i]!
      started = true
    } else if (/\s/.test(ch)) {
      if (started) argv.push(current)
      current = ""
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (started) argv.push(current)
  return argv
}

// Anything outside this set gets quoted. Deliberately narrow: it decides how a
// preset is *displayed*, and a character that looks quotable but is not would
// only show up as a command that no longer round-trips.
const UNQUOTED_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/

function quoteArg(arg: string): string {
  if (UNQUOTED_ARG.test(arg)) return arg
  if (!arg.includes("'")) return `'${arg}'`
  return `"${arg.replace(/["\\]/g, "\\$&")}"`
}

/** Render an argv as a command line that `parseCommandLine` reads back as-is. */
export function formatCommandLine(argv: string[]): string {
  return argv.map(quoteArg).join(" ")
}

/** Does an exec error mean the binary does not exist in the container? */
export function isMissingExecutableError(message: string): boolean {
  return /executable file not found|no such file or directory|not found in \$?PATH/i.test(message)
}

/**
 * What to do when even `/bin/sh` is missing: a distroless image has no shell
 * at all, and no command choice can work around that — the way in is a debug
 * container sharing the pod's namespaces.
 */
export function debugContainerHint(namespace: string, pod: string, container: string): string {
  const target = container !== "" ? ` --target=${container}` : ""
  return `This container has no shell (distroless images ship none). Attach a debug container instead: kubectl debug -it -n ${namespace} ${pod} --image=busybox${target}`
}
