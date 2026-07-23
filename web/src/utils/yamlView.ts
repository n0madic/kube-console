// YAML helpers for viewing and editing Kubernetes objects.

import { parse, stringify } from "yaml"

import type { K8sObject } from "@/api/types"

/** Serialize an object to YAML for the read-only view (as returned by API). */
export function toYaml(obj: unknown): string {
  return stringify(obj, { indent: 2 })
}

/**
 * Prepare an object for server-side-apply editing: strip server-managed
 * fields so the apply patch claims only meaningful ones.
 */
export function toEditableYaml(obj: K8sObject): string {
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
  return stringify(clone, { indent: 2 })
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
