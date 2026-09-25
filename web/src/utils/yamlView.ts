// YAML helpers for viewing and editing Kubernetes objects.

import { parse, stringify } from "yaml"

import type { K8sObject } from "@/api/types"
import { base64ToBytes, bytesToBase64, encodeBase64Utf8, utf8OrNull } from "@/utils/base64"

/** Serialize an object to YAML for the read-only view (as returned by API). */
export function toYaml(obj: unknown): string {
  return stringify(obj, { indent: 2 })
}

/** Deep copy of `obj` without the server-managed fields an apply must not claim. */
function editableClone(obj: K8sObject): K8sObject {
  const clone = JSON.parse(JSON.stringify(obj)) as K8sObject
  delete clone.status
  const meta = clone.metadata
  if (meta !== undefined) {
    delete meta.managedFields
    delete meta.resourceVersion
    delete meta.uid
    delete meta.creationTimestamp
    delete (meta as Record<string, unknown>).generation
  }
  return clone
}

/**
 * Prepare an object for server-side-apply editing: strip server-managed
 * fields so the apply patch claims only meaningful ones.
 */
export function toEditableYaml(obj: K8sObject): string {
  return stringify(editableClone(obj), { indent: 2 })
}

// `!!binary` is the standard YAML tag for bytes: the yaml library turns it into
// a Uint8Array on parse and back on stringify, so a Secret value that is not
// UTF-8 text stays marked as binary through an edit instead of being mistaken
// for text and base64-encoded a second time.
const BINARY_TAGS = { customTags: ["binary" as const] }

/**
 * The editable projection of a Secret with `data` decoded: UTF-8 values as
 * plain text, anything else as `!!binary` base64. `encodeSecretYaml` is the
 * inverse. The apiserver serializes `data` from bytes, so it is always valid
 * base64.
 */
export function toDecodedSecretYaml(obj: K8sObject): string {
  const clone: Record<string, unknown> = editableClone(obj)
  const data = obj.data
  if (data !== undefined && data !== null) {
    // Replacing the value keeps `data` at its position in the document.
    clone.data = Object.fromEntries(
      Object.entries(data).map(([key, b64]) => {
        const bytes = base64ToBytes(b64)
        return [key, utf8OrNull(bytes) ?? bytes]
      }),
    )
  }
  return stringify(clone, { indent: 2, ...BINARY_TAGS })
}

// `ArrayBuffer.isView`, not `instanceof Uint8Array`: what the yaml library
// hands back for `!!binary` may come from another realm (a Node Buffer under
// the test runner), and instanceof is realm-bound.
function isBytes(v: unknown): v is Uint8Array {
  return ArrayBuffer.isView(v)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !isBytes(v)
}

/**
 * Re-encode a manifest produced by `toDecodedSecretYaml` (and edited since):
 * every `data` value back to base64. Values must be strings or `!!binary`
 * bytes — an unquoted `12345` or `true` is refused rather than coerced, since
 * YAML has already changed what was typed (`0777`, `1e3`).
 */
export function encodeSecretYaml(yamlText: string): string {
  const parsed: unknown = parse(yamlText, BINARY_TAGS)
  if (!isRecord(parsed)) {
    throw new Error("The manifest must be a YAML object.")
  }
  const data = parsed.data
  if (data === undefined || data === null) return stringify(parsed, { indent: 2 })
  if (!isRecord(data)) {
    throw new Error("data must be a map of key: value.")
  }
  const encoded = Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      if (typeof value === "string") return [key, encodeBase64Utf8(value)]
      if (isBytes(value)) return [key, bytesToBase64(value)]
      throw new Error(`data.${key} must be a string (or !!binary) — quote the value.`)
    }),
  )
  return stringify({ ...parsed, data: encoded }, { indent: 2 })
}

export interface ParsedManifest {
  object: K8sObject
  name: string
  namespace: string | undefined
}

/** Parse a manifest and extract identity for the apply path. */
export function parseManifest(yamlText: string): ParsedManifest {
  const parsed: unknown = parse(yamlText)
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("The manifest must be a YAML object.")
  }
  const obj = parsed as K8sObject
  const name = obj.metadata?.name
  if (name === undefined || name === "") {
    throw new Error("metadata.name is required for server-side apply.")
  }
  return { object: obj, name, namespace: obj.metadata?.namespace }
}
