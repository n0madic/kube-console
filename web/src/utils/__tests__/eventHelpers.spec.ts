import { describe, expect, it } from "vitest"

import type { K8sObject } from "@/api/types"
import {
  parseEventObjectCell,
  sortByLastSeenDesc,
  toEventRow,
  type EventRow,
} from "@/utils/eventHelpers"

function row(partial: Partial<EventRow>): EventRow {
  return {
    uid: "",
    type: "Normal",
    reason: "",
    message: "",
    count: 1,
    source: "",
    lastSeen: "",
    namespace: "",
    involvedKind: "",
    involvedName: "",
    involvedApiVersion: "v1",
    ...partial,
  }
}

describe("sortByLastSeenDesc", () => {
  it("returns 0 for equal timestamps and keeps tied events stably ordered", () => {
    const ts = "2026-07-20T10:00:00Z"
    const input = [
      row({ uid: "a", lastSeen: ts, reason: "A" }),
      row({ uid: "b", lastSeen: ts, reason: "B" }),
      row({ uid: "c", lastSeen: ts, reason: "C" }),
    ]
    const sorted = sortByLastSeenDesc(input)
    // A stable sort preserves input order for equal keys.
    expect(sorted.map((r) => r.uid)).toEqual(["a", "b", "c"])
  })

  it("orders newest first", () => {
    const sorted = sortByLastSeenDesc([
      row({ uid: "old", lastSeen: "2026-07-20T09:00:00Z" }),
      row({ uid: "new", lastSeen: "2026-07-20T11:00:00Z" }),
      row({ uid: "mid", lastSeen: "2026-07-20T10:00:00Z" }),
    ])
    expect(sorted.map((r) => r.uid)).toEqual(["new", "mid", "old"])
  })

  it("orders mixed-precision timestamps chronologically, not lexicographically", () => {
    // Same second: the microsecond event (…05.5Z) is actually newer than the
    // whole-second one (…05Z), but "…05.5Z" < "…05Z" lexicographically ('.'<'Z'),
    // so a raw string compare would reverse them.
    const sorted = sortByLastSeenDesc([
      row({ uid: "whole", lastSeen: "2026-07-20T10:00:05Z" }),
      row({ uid: "frac", lastSeen: "2026-07-20T10:00:05.500000Z" }),
    ])
    expect(sorted.map((r) => r.uid)).toEqual(["frac", "whole"])
  })

  it("sorts rows with an unparseable timestamp last", () => {
    const sorted = sortByLastSeenDesc([
      row({ uid: "missing", lastSeen: "" }),
      row({ uid: "real", lastSeen: "2026-07-20T10:00:00Z" }),
    ])
    expect(sorted.map((r) => r.uid)).toEqual(["real", "missing"])
  })
})

describe("toEventRow", () => {
  it("falls through an empty-string lastTimestamp to eventTime", () => {
    const obj: K8sObject = {
      lastTimestamp: "",
      eventTime: "2026-07-20T10:00:00Z",
      metadata: { creationTimestamp: "2026-07-20T08:00:00Z" },
    } as unknown as K8sObject
    expect(toEventRow(obj).lastSeen).toBe("2026-07-20T10:00:00Z")
  })

  it("falls through an empty-string source component to reportingComponent", () => {
    const obj: K8sObject = {
      source: { component: "" },
      reportingComponent: "kubelet",
    } as unknown as K8sObject
    expect(toEventRow(obj).source).toBe("kubelet")
  })

  it("carries metadata.uid as the row identity", () => {
    const obj: K8sObject = { metadata: { uid: "evt-1" } } as K8sObject
    expect(toEventRow(obj).uid).toBe("evt-1")
  })
})

describe("parseEventObjectCell", () => {
  it("splits the printer's '<kind>/<name>' cell", () => {
    expect(parseEventObjectCell("pod/nginx-abc")).toEqual({ kind: "pod", name: "nginx-abc" })
    expect(parseEventObjectCell("horizontalpodautoscaler/web")).toEqual({
      kind: "horizontalpodautoscaler",
      name: "web",
    })
  })

  it("rejects cells that are not a kind/name pair", () => {
    expect(parseEventObjectCell("")).toBeNull()
    expect(parseEventObjectCell("<none>")).toBeNull()
    expect(parseEventObjectCell("pod/")).toBeNull()
    expect(parseEventObjectCell("/nginx")).toBeNull()
    // A name never contains a slash — a subresource path is not an object.
    expect(parseEventObjectCell("pod/nginx/log")).toBeNull()
  })
})
