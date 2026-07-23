// Classify an arbitrary Kubernetes spec/status object into a renderable
// field tree. Heuristics are shape-based (never kind-based) so the same
// logic covers built-in resources and any CRD:
//   scalar                        → leaf row (timestamps get a relative-age
//                                   suffix, status-ish keys get color-coding)
//   array of scalars              → chips
//   label-like map                → chips (k=v)
//   flat homogeneous object array → mini-table
//   other object array            → titled collapsible items
//   nested object                 → collapsible group

import { isStatusColumn, statusTextClass } from "@/utils/statusColors"
import { formatRelativeAge } from "@/utils/units"

/**
 * A reference to another object, recognized by shape: any nested record with a
 * `kind` and a `name` (Event `involvedObject`/`related`, RBAC `roleRef` and
 * `subjects`, HPA `scaleTargetRef`, PVC `dataSource`, CRD fields alike). The
 * renderer turns the name into a link; resolving the kind is its job, not this
 * module's (which stays pure and shape-based).
 */
export interface ObjectRef {
  /** "v1", "apps/v1" — absent on RBAC-style refs, which carry apiGroup. */
  apiVersion?: string
  apiGroup?: string
  kind: string
  name: string
  /** Absent when the ref lives in the referring object's own namespace. */
  namespace?: string
}

export interface LeafNode {
  type: "leaf"
  key: string
  label: string
  text: string
  /** Muted non-mono suffix, e.g. "(5h ago)". */
  suffix: string
  statusClass: string | null
  /** Long/multiline values start collapsed in the UI. */
  long: boolean
  /** Set on the `name` leaf of an object reference: render it as a link. */
  ref?: ObjectRef
}

export interface Chip {
  text: string
  /** Long/multiline chip values start truncated in the UI. */
  long: boolean
}

export interface ChipsNode {
  type: "chips"
  key: string
  label: string
  chips: Chip[]
}

export interface TableCell {
  text: string
  statusClass: string | null
  /** Long/multiline cell values start collapsed in the UI. */
  long: boolean
}

export interface TableNode {
  type: "table"
  key: string
  label: string
  columns: string[]
  rows: TableCell[][]
}

export interface GroupNode {
  type: "group"
  key: string
  label: string
  children: FieldNode[]
  /** Recursive row count, used for auto-collapsing big subtrees. */
  leafCount: number
}

export interface ItemsNode {
  type: "items"
  key: string
  label: string
  items: Array<{ title: string; children: FieldNode[]; leafCount: number }>
  leafCount: number
}

export type FieldNode = LeafNode | ChipsNode | TableNode | GroupNode | ItemsNode

export const LONG_VALUE_CHARS = 140

// Guard against pathologically deep structures (or an accidental cyclic graph
// passed in by a caller): beyond this nesting level a value is rendered as a
// single JSON leaf instead of recursing further. JSON.parse output is acyclic,
// so this only ever trips on genuinely huge CRDs.
const MAX_DEPTH = 32

// Lowercase words rendered as acronyms by humanizeKey.
const ACRONYMS = new Set([
  "api", "cidr", "cpu", "dns", "fqdn", "fs", "gid", "http", "https", "id",
  "ip", "ipc", "os", "pid", "qos", "tls", "ttl", "uid", "url",
])

/** "dnsPolicy" → "DNS Policy", "hostIP" → "Host IP", "podCIDRs" → "Pod CIDRs". */
export function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter((word) => word !== "")
    .map((word) => {
      if (word.length > 1 && /^[A-Z\d]+s?$/.test(word)) return word
      if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase()
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(" ")
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIMESTAMP_RE.test(value)
}

type Scalar = string | number | boolean | null

function isScalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function formatScalar(value: Scalar): string {
  return value === null ? "null" : String(value)
}

function leafStatusClass(key: string, text: string): string | null {
  return isStatusColumn(key) ? statusTextClass(text) : null
}

function isLongText(text: string): boolean {
  return text.length > LONG_VALUE_CHARS || text.includes("\n")
}

function makeChip(text: string): Chip {
  return { text, long: isLongText(text) }
}

function makeLeaf(key: string, text: string, suffix = ""): LeafNode {
  return {
    type: "leaf",
    key,
    label: humanizeKey(key),
    text,
    suffix,
    statusClass: leafStatusClass(key, text),
    long: isLongText(text),
  }
}

function scalarLeaf(key: string, value: Scalar): LeafNode {
  const text = formatScalar(value)
  const rel = isTimestamp(value) ? formatRelativeAge(value) : ""
  return makeLeaf(key, text, rel !== "" ? `(${rel})` : "")
}

// nodeSelector, matchLabels, spec.selector (Service) and similar maps read
// best as k=v chips; other all-string objects (capacity, resource requests)
// stay as key/value rows.
const LABEL_MAP_KEY_RE = /(selector|labels|annotations)$/i

function isLabelMap(key: string, value: Record<string, unknown>): boolean {
  const entries = Object.values(value)
  return (
    LABEL_MAP_KEY_RE.test(key) &&
    entries.length > 0 &&
    entries.every((v) => typeof v === "string")
  )
}

const MAX_TABLE_COLUMNS = 8

function isFlatHomogeneousArray(items: Record<string, unknown>[]): boolean {
  if (items.length < 2) return false
  const columns = new Set<string>()
  for (const item of items) {
    const keys = Object.keys(item)
    if (keys.length === 0) return false
    for (const key of keys) {
      if (!isScalar(item[key])) return false
      columns.add(key)
    }
  }
  return columns.size <= MAX_TABLE_COLUMNS
}

function tableNode(key: string, items: Record<string, unknown>[]): TableNode {
  const columnKeys: string[] = []
  for (const item of items) {
    for (const k of Object.keys(item)) {
      if (!columnKeys.includes(k)) columnKeys.push(k)
    }
  }
  const rows = items.map((item) =>
    columnKeys.map((col): TableCell => {
      const raw = item[col]
      if (raw === undefined) return { text: "", statusClass: null, long: false }
      const scalar = raw as Scalar
      // Timestamps read better as a compact relative age inside table cells.
      const rel = isTimestamp(scalar) ? formatRelativeAge(scalar) : ""
      const text = rel !== "" ? rel : formatScalar(scalar)
      return {
        text,
        statusClass: leafStatusClass(col, text),
        long: isLongText(text),
      }
    }),
  )
  return { type: "table", key, label: humanizeKey(key), columns: columnKeys.map(humanizeKey), rows }
}

const ITEM_TITLE_KEYS = [
  "name", "key", "type", "ip", "hostname", "path", "containerName", "topologyKey",
]

export function itemTitle(item: Record<string, unknown>, index: number): string {
  for (const key of ITEM_TITLE_KEYS) {
    const value = item[key]
    if (isScalar(value) && value !== null && String(value) !== "") return String(value)
  }
  return `#${index + 1}`
}

function nodeSize(node: FieldNode): number {
  switch (node.type) {
    case "leaf":
    case "chips":
      return 1
    case "table":
      return node.rows.length
    case "group":
    case "items":
      return node.leafCount
  }
}

function sizeOf(children: FieldNode[]): number {
  return children.reduce((sum, child) => sum + nodeSize(child), 0)
}

function itemsNode(key: string, items: Record<string, unknown>[], depth: number): ItemsNode {
  const built = items.map((item, index) => {
    const children = buildChildren(item, depth)
    return { title: itemTitle(item, index), children, leafCount: sizeOf(children) }
  })
  return {
    type: "items",
    key,
    label: humanizeKey(key),
    items: built,
    leafCount: built.reduce((sum, item) => sum + 1 + item.leafCount, 0),
  }
}

function arrayNode(key: string, value: unknown[], depth: number): FieldNode {
  if (value.length === 0) return makeLeaf(key, "[]")
  if (value.every(isScalar)) {
    return { type: "chips", key, label: humanizeKey(key), chips: value.map((v) => makeChip(formatScalar(v))) }
  }
  if (value.every(isPlainObject)) {
    return isFlatHomogeneousArray(value) ? tableNode(key, value) : itemsNode(key, value, depth)
  }
  // Mixed scalar/object arrays are practically nonexistent; show raw JSON.
  return makeLeaf(key, JSON.stringify(value))
}

function buildNode(key: string, value: unknown, depth: number): FieldNode {
  if (isScalar(value)) return scalarLeaf(key, value)
  // Depth cap: render anything deeper as a single JSON leaf (see MAX_DEPTH).
  if (depth >= MAX_DEPTH) return makeLeaf(key, JSON.stringify(value))
  if (Array.isArray(value)) return arrayNode(key, value, depth)
  if (isPlainObject(value)) {
    if (isLabelMap(key, value)) {
      return {
        type: "chips",
        key,
        label: humanizeKey(key),
        chips: Object.entries(value).map(([k, v]) => makeChip(`${k}=${String(v)}`)),
      }
    }
    const children = buildChildren(value, depth)
    return { type: "group", key, label: humanizeKey(key), children, leafCount: sizeOf(children) }
  }
  // undefined or exotic values cannot come from JSON; render as empty leaf.
  return makeLeaf(key, "")
}

/** Non-empty string field, or undefined. */
function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key]
  return typeof raw === "string" && raw !== "" ? raw : undefined
}

/** Read a record as an object reference — `kind` + `name` is the whole rule. */
export function objectRefOf(value: Record<string, unknown>): ObjectRef | null {
  const kind = stringField(value, "kind")
  const name = stringField(value, "name")
  if (kind === undefined || name === undefined) return null
  return {
    apiVersion: stringField(value, "apiVersion"),
    apiGroup: stringField(value, "apiGroup"),
    kind,
    name,
    namespace: stringField(value, "namespace"),
  }
}

function buildChildren(value: Record<string, unknown>, depth: number): FieldNode[] {
  const ref = objectRefOf(value)
  return Object.entries(value).map(([key, child]) => {
    const node = buildNode(key, child, depth + 1)
    // The name identifies the referenced object, so it carries the link.
    return ref !== null && key === "name" && node.type === "leaf" ? { ...node, ref } : node
  })
}

/**
 * Build the renderable field tree for a spec/status object. Key order is
 * preserved as served by the API (matches the YAML tab). Returns [] when the
 * value is not a plain object (caller falls back to raw JSON).
 */
export function buildFieldTree(value: unknown, opts: { skipKeys?: string[] } = {}): FieldNode[] {
  if (!isPlainObject(value)) return []
  const skip = new Set(opts.skipKeys ?? [])
  return Object.entries(value)
    .filter(([key]) => !skip.has(key))
    .map(([key, child]) => buildNode(key, child, 0))
}
