// Secret-specific predicates shared by the detail views.

import type { K8sObject } from "@/api/types"
import { LAST_APPLIED_ANNOTATION } from "@/utils/fieldFilter"

/** A core Secret, matched on the object itself (apiVersion + kind). */
export function isSecret(obj: K8sObject): boolean {
  return obj.apiVersion === "v1" && obj.kind === "Secret"
}

/**
 * Annotations whose value carries Secret data and must be hidden whole, not
 * truncated: `kubectl apply` stores the full manifest in last-applied-
 * configuration — `data` (base64) or even `stringData` in plain text — so any
 * visible prefix can already be part of a secret.
 */
export function isMaskedAnnotation(obj: K8sObject, key: string): boolean {
  return isSecret(obj) && key === LAST_APPLIED_ANNOTATION
}
