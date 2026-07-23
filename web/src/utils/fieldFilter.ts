// Noise reduction for the Overview field tree:
//   - pruneEmpty: drop null / "" / {} / [] recursively (shape-based, universal)
//   - compactSpec: narrow a spec to the fields the user actually declared, so
//     API-server defaults (dnsPolicy, terminationMessagePath, revisionHistory-
//     Limit, …) stop cluttering the view.
//
// "User-declared" is resolved from whichever signal the object carries, in
// order of reliability:
//   1. kubectl.kubernetes.io/last-applied-configuration — the verbatim manifest
//      of a client-side `kubectl apply`. This is the common case, and the ONLY
//      signal that works for it: client-side apply round-trips the whole
//      defaulted object, so managedFields wrongly reports the user manager as
//      owning the defaults too.
//   2. Server-Side Apply ownership — managedFields entries with operation
//      "Apply" (kubectl apply --server-side, ArgoCD, Flux). SSA does not write
//      the annotation and its Apply fieldset excludes defaults, so ownership is
//      trustworthy here (unlike "Update" ownership, which we ignore).
//   3. Neither → plain empty-pruning only (controller-owned Pods/ReplicaSets,
//      `kubectl create` objects). Nothing is hidden beyond empties.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Accumulator for filtered object output. Null-prototype because the keys are
 * Kubernetes field names: a field literally called "__proto__" assigned into a
 * plain `{}` hits the Object.prototype setter and vanishes from the result
 * (and, with an object value, silently reparents the accumulator) instead of
 * becoming an own key. Every consumer duck-types records (isRecord,
 * fieldTree.isPlainObject, Object.entries, JSON.stringify), so the missing
 * prototype changes nothing downstream. */
function emptyRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true
  if (Array.isArray(value)) return value.length === 0
  if (isRecord(value)) return Object.keys(value).length === 0
  return false
}

/** Recursively remove null / undefined / "" / {} / [] (but keep 0 and false). */
export function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pruneEmpty).filter((v) => !isEmpty(v))
  }
  if (isRecord(value)) {
    const out = emptyRecord()
    for (const [key, child] of Object.entries(value)) {
      const pruned = pruneEmpty(child)
      if (!isEmpty(pruned)) out[key] = pruned
    }
    return out
  }
  return value
}

// --- Signal 1: last-applied-configuration -----------------------------------

const LAST_APPLIED_ANNOTATION = "kubectl.kubernetes.io/last-applied-configuration"

function parseLastAppliedSpec(
  annotations: Record<string, string> | undefined,
): Record<string, unknown> | null {
  const raw = annotations?.[LAST_APPLIED_ANNOTATION]
  if (typeof raw !== "string" || raw === "") return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed) && isRecord(parsed.spec)) return parsed.spec
  } catch {
    /* malformed annotation — ignore */
  }
  return null
}

// Keys used to pair a live list element with the manifest element that declared
// it (strategic-merge patch merge keys). Falls back to positional matching.
const MERGE_KEYS = [
  "name",
  "key",
  "containerPort",
  "port",
  "mountPath",
  "devicePath",
  "ip",
  "topologyKey",
  "path",
]

function correspondingIndex(el: Record<string, unknown>, template: unknown[]): number {
  for (const mk of MERGE_KEYS) {
    if (!(mk in el)) continue
    const idx = template.findIndex((t) => isRecord(t) && t[mk] === el[mk])
    if (idx >= 0) return idx
  }
  return -1
}

/** Keep only the parts of `live` that the manifest `template` declared. */
function intersectWithTemplate(live: unknown, template: unknown): unknown {
  if (Array.isArray(live) && Array.isArray(template)) {
    // A scalar list is shown whole — the user listed its members.
    if (!live.every(isRecord)) return live
    const out: unknown[] = []
    live.forEach((el, i) => {
      let ti = correspondingIndex(el, template)
      if (ti < 0 && template.length === live.length && isRecord(template[i])) ti = i
      if (ti < 0) return // element the user never declared (e.g. injected sidecar)
      out.push(intersectWithTemplate(el, template[ti]))
    })
    return out
  }
  if (isRecord(live) && isRecord(template)) {
    const out = emptyRecord()
    for (const [key, child] of Object.entries(live)) {
      // Own keys only: a live field or map key named after an Object.prototype
      // member ("constructor", "toString", a label called "valueOf", …) would
      // otherwise read as declared by the manifest, and `template[key]` — a
      // function — would fall through to the type-mismatch branch and keep the
      // whole defaulted subtree that compact mode exists to hide.
      if (Object.hasOwn(template, key)) out[key] = intersectWithTemplate(child, template[key])
    }
    return out
  }
  // Leaf the user declared, or a type mismatch: keep the live value.
  return live
}

// --- Signal 2: Server-Side Apply ownership ----------------------------------

// A FieldsV1 node: keys are "f:<field>", "k:{json}", "v:<json>", "i:<idx>" or
// "." (self marker). An empty node (or one holding only self markers) means the
// whole subtree below the corresponding value is owned.
type FieldSet = Record<string, unknown>

function ownsWhole(fs: FieldSet): boolean {
  const keys = Object.keys(fs)
  return keys.length === 0 || keys.every((k) => k === ".")
}

function keyMatches(el: Record<string, unknown>, keyJson: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(keyJson)
  } catch {
    return false
  }
  if (!isRecord(parsed)) return false
  return Object.entries(parsed).every(([k, v]) => el[k] === v)
}

function matchArrayElement(el: unknown, fs: FieldSet): FieldSet | undefined {
  if (isRecord(el)) {
    for (const fsKey of Object.keys(fs)) {
      if (fsKey.startsWith("k:") && keyMatches(el, fsKey.slice(2))) {
        return isRecord(fs[fsKey]) ? (fs[fsKey] as FieldSet) : {}
      }
    }
    return undefined
  }
  for (const fsKey of Object.keys(fs)) {
    if (fsKey.startsWith("v:")) {
      try {
        if (JSON.parse(fsKey.slice(2)) === el) return {}
      } catch {
        /* malformed entry — ignore */
      }
    }
  }
  return undefined
}

function filterValue(value: unknown, fs: FieldSet): unknown {
  if (ownsWhole(fs)) return value
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const el of value) {
      const childFs = matchArrayElement(el, fs)
      if (childFs !== undefined) out.push(filterValue(el, childFs))
    }
    return out
  }
  if (isRecord(value)) {
    const out = emptyRecord()
    for (const [key, child] of Object.entries(value)) {
      const childFs = fs[`f:${key}`]
      if (isRecord(childFs)) out[key] = filterValue(child, childFs as FieldSet)
    }
    return out
  }
  return value
}

function mergeFieldSets(a: FieldSet, b: FieldSet): FieldSet {
  if (ownsWhole(a) || ownsWhole(b)) return {}
  const out: FieldSet = {}
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[key]
    const bv = b[key]
    if (isRecord(av) && isRecord(bv)) out[key] = mergeFieldSets(av as FieldSet, bv as FieldSet)
    else out[key] = isRecord(av) ? av : isRecord(bv) ? bv : {}
  }
  return out
}

interface ManagedFieldsEntry {
  manager?: string
  operation?: string
  subresource?: string
  fieldsV1?: unknown
}

/**
 * Merged "f:spec" fieldset across Server-Side Apply entries, or null when none.
 * Only operation "Apply" is trusted: "Update" ownership (client-side apply,
 * `kubectl edit`) includes defaults the manager round-tripped.
 */
export function extractOwnedSpec(managedFields: unknown): FieldSet | null {
  if (!Array.isArray(managedFields)) return null
  let merged: FieldSet | null = null
  for (const raw of managedFields) {
    if (!isRecord(raw)) continue
    const entry = raw as ManagedFieldsEntry
    if (entry.operation !== "Apply") continue
    if (entry.subresource !== undefined && entry.subresource !== "") continue
    if (!isRecord(entry.fieldsV1)) continue
    const specFs = (entry.fieldsV1 as FieldSet)["f:spec"]
    if (!isRecord(specFs)) continue
    merged = merged === null ? (specFs as FieldSet) : mergeFieldSets(merged, specFs as FieldSet)
  }
  return merged
}

// --- Public API -------------------------------------------------------------

export interface CompactMeta {
  annotations?: Record<string, string>
  managedFields?: unknown
}

export interface CompactResult {
  value: unknown
  /** True when the spec was narrowed to user-declared fields. */
  filtered: boolean
  source: "last-applied" | "managed-fields" | "none"
}

/**
 * Compact a spec for display: keep only user-declared fields (via the best
 * available signal) and drop empties. Falls back to plain empty-pruning when no
 * signal exists or filtering would hide everything.
 */
export function compactSpec(spec: unknown, meta: CompactMeta | undefined): CompactResult {
  const template = parseLastAppliedSpec(meta?.annotations)
  if (template !== null) {
    const filtered = pruneEmpty(intersectWithTemplate(spec, template))
    if (!isEmpty(filtered)) return { value: filtered, filtered: true, source: "last-applied" }
  }
  const owned = extractOwnedSpec(meta?.managedFields)
  if (owned !== null) {
    const filtered = pruneEmpty(filterValue(spec, owned))
    if (!isEmpty(filtered)) return { value: filtered, filtered: true, source: "managed-fields" }
  }
  return { value: pruneEmpty(spec), filtered: false, source: "none" }
}
