import { afterEach, describe, expect, it, vi } from "vitest"

import type { K8sObject } from "@/api/types"
import {
  eventRowClass,
  parseEventObjectCell,
  sortByLastSeenDesc,
  toEventRow,
  type EventRow,
} from "@/utils/eventHelpers"

const ERROR_ROW_CLASS = "bg-red-50 dark:bg-red-950/40"
const WARNING_ROW_CLASS = "bg-amber-50 dark:bg-amber-950/30"

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

describe("eventRowClass", () => {
  afterEach(() => {
    vi.doUnmock("@/utils/statusColors")
    vi.resetModules()
  })

  it("leaves anything but a Warning event untinted", () => {
    for (const type of ["Normal", "", "warning"]) {
      expect(eventRowClass(row({ type, reason: "FailedMount" })), type).toBe("")
    }
  })

  it("tints a Warning with an error-like reason red", () => {
    for (const reason of ["FailedMount", "BackOff", "Unhealthy", "FailedScheduling", "ErrImagePull"]) {
      expect(eventRowClass(row({ type: "Warning", reason })), reason).toBe(ERROR_ROW_CLASS)
    }
  })

  it("tints a Warning with a neutral or merely-warning reason amber", () => {
    for (const reason of ["Scheduled", "Pulled", "NodeNotSchedulable", "", "Unschedulable"]) {
      expect(eventRowClass(row({ type: "Warning", reason })), reason).toBe(WARNING_ROW_CLASS)
    }
  })

  /**
   * The decoupling itself. eventRowClass used to recover the severity by
   * searching statusTextClass' output for the substring "red", which made a
   * cosmetic repaint semantically load-bearing. Here statusTextClass is replaced
   * with a rose- palette holding no "red" at all: the tint must stay red, and
   * the spies must show *which* function was consulted — without them the test
   * would also pass if the mock never reached eventHelpers.
   */
  it("reads the severity, not the text color's palette name", async () => {
    const actual = await vi.importActual<typeof import("@/utils/statusColors")>(
      "@/utils/statusColors",
    )
    const severity = vi.fn(actual.statusSeverity)
    const textClass = vi.fn((value: string) =>
      actual.statusSeverity(value) === "error"
        ? "text-rose-600 dark:text-rose-400 font-medium"
        : actual.statusTextClass(value),
    )
    vi.resetModules()
    vi.doMock("@/utils/statusColors", () => ({ ...actual, statusSeverity: severity, statusTextClass: textClass }))

    const mocked = await import("@/utils/eventHelpers")
    expect(mocked.eventRowClass({ type: "Warning", reason: "FailedMount" })).toBe(ERROR_ROW_CLASS)
    // Proof the mock is the module under test's dependency, and that the class
    // string plays no part in the decision.
    expect(severity).toHaveBeenCalledWith("FailedMount")
    expect(textClass).not.toHaveBeenCalled()
  })
})
