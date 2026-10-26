// The resource list page's view state as URL query parameters, so Back from a
// detail page, a reload and a shared link all land on the same filtered view.
// Defaults are never written: a fresh list carries a bare URL.

import type { LocationQuery, LocationQueryValue } from "vue-router"

import { isDNS1123Label } from "./k8sNames"

export interface ListQueryState {
  /**
   * Selected namespace; `""` is the default (all namespaces, or none for a
   * cluster-scoped resource) and is not written. Read back, `""` means the URL
   * names none — keep the current selection, which is global (sidebar links
   * carry no query).
   */
  namespace: string
  /** Client-side row filter, as typed. */
  filter: string
  /** The applied label selector. */
  labelSelector: string
}

function first(value: LocationQueryValue | LocationQueryValue[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === "string" ? v : ""
}

/**
 * Read the list view state from a route query. A namespace that is not a
 * DNS-1123 label reads as none: the value comes from a link anyone can write,
 * and lands in the persisted namespace selection.
 */
export function parseListQuery(query: LocationQuery): ListQueryState {
  const ns = first(query.namespace)
  return {
    namespace: isDNS1123Label(ns) ? ns : "",
    filter: first(query.filter),
    labelSelector: first(query.selector),
  }
}

/** The route query for a list view, defaults (empty values) omitted. */
export function listQuery(state: ListQueryState): Record<string, string> {
  const query: Record<string, string> = {}
  if (state.namespace !== "") query.namespace = state.namespace
  if (state.filter !== "") query.filter = state.filter
  if (state.labelSelector !== "") query.selector = state.labelSelector
  return query
}

/** True when `current` holds exactly `wanted`, nothing more and nothing less. */
export function sameQuery(wanted: Record<string, string>, current: LocationQuery): boolean {
  const keys = Object.keys(current)
  if (keys.length !== Object.keys(wanted).length) return false
  return keys.every((k) => Object.hasOwn(wanted, k) && current[k] === wanted[k])
}
