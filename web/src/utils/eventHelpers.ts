// Shared mapping/coloring for Kubernetes Event objects (detail tab and the
// overview recent-events card).

import type { K8sObject } from "@/api/types"
import { statusSeverity } from "./statusColors"

export interface EventRow {
  /** Stable identity for list keys (metadata.uid). */
  uid: string
  type: string
  reason: string
  message: string
  count: number
  source: string
  lastSeen: string
  namespace: string
  involvedKind: string
  involvedName: string
  involvedApiVersion: string
}

interface EventLike extends K8sObject {
  type?: string
  reason?: string
  message?: string
  count?: number
  source?: { component?: string }
  reportingComponent?: string
  lastTimestamp?: string
  eventTime?: string
  involvedObject?: { kind?: string; name?: string; namespace?: string; apiVersion?: string }
}

export function toEventRow(obj: K8sObject): EventRow {
  const e = obj as EventLike
  return {
    uid: e.metadata?.uid ?? "",
    type: e.type ?? "",
    reason: e.reason ?? "",
    message: e.message ?? "",
    count: e.count ?? 1,
    // Use || (not ??) so an empty-string timestamp/component falls through to
    // the next source instead of sticking as "".
    source: e.source?.component || e.reportingComponent || "",
    lastSeen: e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp || "",
    namespace: e.involvedObject?.namespace ?? e.metadata?.namespace ?? "",
    involvedKind: e.involvedObject?.kind ?? "",
    involvedName: e.involvedObject?.name ?? "",
    involvedApiVersion: e.involvedObject?.apiVersion ?? "v1",
  }
}

/**
 * Split the Table API "Object" cell of an event ("pod/nginx-abc") into the
 * involved object's kind and name. The server printer lowercases the kind and
 * prints no apiVersion, so the kind comes back as printed and must be resolved
 * case-insensitively (`useDiscovery().findByLowerKind`).
 */
export function parseEventObjectCell(text: string): { kind: string; name: string } | null {
  const slash = text.indexOf("/")
  if (slash < 0) return null
  const kind = text.slice(0, slash).trim()
  const name = text.slice(slash + 1).trim()
  // A name never contains "/" — anything else is not a "<kind>/<name>" cell.
  if (kind === "" || name === "" || name.includes("/")) return null
  return { kind, name }
}

export function sortByLastSeenDesc(rows: EventRow[]): EventRow[] {
  // Compare by parsed time, not raw string: lastSeen mixes second-precision
  // core timestamps ("…05Z") with microsecond events.k8s.io ones ("…05.5Z"),
  // which a lexicographic compare misorders within the same second ('.' < 'Z').
  // When either side is unparseable the raw strings decide, descending; equal
  // values return 0 so the stable sort keeps them in their original order.
  //
  // Parsed once per row, not once per comparison: RecentEventsCard sorts up to
  // 1000 events on mount, on every namespace and cluster switch and on every
  // Refresh, and a comparator-side parse costs ~2·n·log₂n of them (~20k) to
  // order n rows.
  return rows
    .map((row) => ({ row, t: Date.parse(row.lastSeen) }))
    .sort((a, b) => {
      if (Number.isNaN(a.t) || Number.isNaN(b.t)) {
        return a.row.lastSeen === b.row.lastSeen ? 0 : a.row.lastSeen < b.row.lastSeen ? 1 : -1
      }
      return b.t - a.t
    })
    .map(({ row }) => row)
}

/**
 * Alarming rows: Warning events get an amber tint, error-like reasons
 * (Failed*, BackOff, Unhealthy, ...) a red one.
 *
 * The reason is classified with statusSeverity, never by searching the text
 * color statusTextClass returns for "red": that recovered the severity from a
 * palette name, so repainting error text to rose- (as GaugeCard already does)
 * would have quietly downgraded every error row's background to amber.
 * Each branch is one complete class string, per the Tailwind order rule.
 */
export function eventRowClass(row: Pick<EventRow, "type" | "reason">): string {
  if (row.type !== "Warning") return ""
  return statusSeverity(row.reason) === "error"
    ? "bg-red-50 dark:bg-red-950/40"
    : "bg-amber-50 dark:bg-amber-950/30"
}
