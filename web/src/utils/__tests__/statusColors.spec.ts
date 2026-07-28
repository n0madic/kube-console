import { describe, expect, it } from "vitest"

import { cellTextClass, isStatusColumn, statusColumnKind, statusSeverity, statusTextClass } from "@/utils/statusColors"

// statusSeverity is the classification itself; statusTextClass is one mapping of
// it. Callers needing another presentation (eventHelpers tints whole rows) read
// the severity instead of searching a class string for a palette name.
describe("statusSeverity", () => {
  it("classifies error statuses and error substrings", () => {
    for (const status of [
      "Failed",
      "Error",
      "Evicted",
      "OOMKilled",
      "NotReady",
      "Unknown",
      "Invalid",
      "CrashLoopBackOff",
      "ImagePullBackOff",
      "ErrImagePull",
      "Init:CrashLoopBackOff",
      "FailedMount",
      "FailedScheduling",
      "Unhealthy",
      "BackOff",
      "CreateContainerConfigError",
    ]) {
      expect(statusSeverity(status), status).toBe("error")
    }
  })

  it("classifies transitional statuses and the event Type column as warnings", () => {
    for (const status of [
      "Pending",
      "Terminating",
      "ContainerCreating",
      "PodInitializing",
      "SchedulingDisabled",
      "Unschedulable",
      "Progressing",
      "Warning",
    ]) {
      expect(statusSeverity(status), status).toBe("warning")
    }
  })

  it("leaves neutral values and the empty string unclassified", () => {
    for (const value of ["Running", "Active", "Completed", "1/1", "5d", "api-server-1", "", ",,", "True", "False"]) {
      expect(statusSeverity(value), JSON.stringify(value)).toBeNull()
    }
  })

  // The comma-joined Node STATUS: worst part wins, wherever it sits.
  it("takes the worst severity of a comma-joined value", () => {
    expect(statusSeverity("NotReady,SchedulingDisabled")).toBe("error")
    expect(statusSeverity("SchedulingDisabled,NotReady")).toBe("error")
    expect(statusSeverity("SchedulingDisabled")).toBe("warning")
    expect(statusSeverity("Ready,SchedulingDisabled")).toBe("warning")
    expect(statusSeverity("Ready,Active")).toBeNull()
    // Whitespace around the parts is the printer's, not a value.
    expect(statusSeverity("Ready, SchedulingDisabled")).toBe("warning")
  })

  it("is case-insensitive", () => {
    expect(statusSeverity("failed")).toBe("error")
    expect(statusSeverity("PENDING")).toBe("warning")
  })
})

// Equivalence pin: statusTextClass is what four components and fieldTree render,
// so the exact strings are spelled out here — a palette change must show up as a
// failing test, not as a silent repaint (and, before eventRowClass stopped
// sniffing this string for "red", as a silent severity change too).
describe("statusTextClass class strings", () => {
  it("maps each severity to one complete class string", () => {
    expect(statusTextClass("Failed")).toBe("text-red-600 dark:text-red-400 font-medium")
    expect(statusTextClass("NotReady,SchedulingDisabled")).toBe(
      "text-red-600 dark:text-red-400 font-medium",
    )
    expect(statusTextClass("Pending")).toBe("text-amber-600 dark:text-amber-400")
    expect(statusTextClass("Ready,SchedulingDisabled")).toBe("text-amber-600 dark:text-amber-400")
    expect(statusTextClass("Running")).toBeNull()
    expect(statusTextClass("")).toBeNull()
  })

  it("agrees with statusSeverity on every value", () => {
    for (const value of [
      "Failed",
      "Unhealthy",
      "NotReady,SchedulingDisabled",
      "Pending",
      "Warning",
      "Ready,SchedulingDisabled",
      "Running",
      "1/1",
      "",
    ]) {
      const severity = statusSeverity(value)
      const expected =
        severity === "error"
          ? "text-red-600 dark:text-red-400 font-medium"
          : severity === "warning"
            ? "text-amber-600 dark:text-amber-400"
            : null
      expect(statusTextClass(value), value).toBe(expected)
    }
  })
})

describe("statusTextClass", () => {
  it("marks error-like statuses red", () => {
    for (const status of [
      "Failed",
      "Error",
      "CrashLoopBackOff",
      "ImagePullBackOff",
      "ErrImagePull",
      "Init:CrashLoopBackOff",
      "Init:Error",
      "Evicted",
      "OOMKilled",
      "NotReady",
      "FailedMount",
      "FailedScheduling",
      "Unhealthy",
    ]) {
      expect(statusTextClass(status), status).toContain("text-red")
    }
  })

  it("marks transitional statuses and event Warning amber", () => {
    for (const status of ["Pending", "Terminating", "ContainerCreating", "Warning"]) {
      expect(statusTextClass(status), status).toContain("text-amber")
    }
  })

  it("recognizes status-bearing columns by name", () => {
    for (const name of ["Status", "Last State", "Reason", "Type", "Phase", "Conditions", "Ready", "Sync Status"]) {
      expect(isStatusColumn(name), name).toBe(true)
    }
    for (const name of ["Name", "Selector", "Images", "Age", "IP", "Node", "Message"]) {
      expect(isStatusColumn(name), name).toBe(false)
    }
  })

  // kubectl's Node printer joins the STATUS conditions with commas, so a
  // cordoned node never shows a bare "SchedulingDisabled" — the parts must be
  // classified, worst severity winning, or "NotReady,SchedulingDisabled"
  // renders exactly like a healthy node.
  it("classifies comma-joined node statuses by their worst part", () => {
    expect(statusTextClass("Ready,SchedulingDisabled")).toContain("text-amber")
    expect(statusTextClass("NotReady,SchedulingDisabled")).toContain("text-red")
    expect(statusTextClass("Unknown,SchedulingDisabled")).toContain("text-red")
    // The error part wins wherever it sits in the list.
    expect(statusTextClass("SchedulingDisabled,NotReady")).toContain("text-red")
    // All-neutral parts stay neutral.
    expect(statusTextClass("Ready,Active")).toBeNull()
  })

  it("leaves neutral values unstyled", () => {
    for (const value of ["Running", "Active", "Completed", "1/1", "5d", "api-server-1", "", "True", "False"]) {
      expect(statusTextClass(value), value).toBeNull()
    }
  })
})

// A CronJob's SUSPEND cell is a boolean whose "True" is the notable state, the
// opposite polarity of every status column — hence a kind of its own rather
// than "true" added to the warning statuses, which would also light up a field
// tree's healthy `ready: true`.
describe("warn-when-true columns", () => {
  it("classifies suspend columns as their own kind", () => {
    for (const name of ["Suspend", "SUSPEND", "suspend", "suspended"]) {
      expect(statusColumnKind(name), name).toBe("warn-when-true")
    }
    expect(statusColumnKind("Status")).toBe("status")
    expect(statusColumnKind("Name")).toBeNull()
    // Not every column merely containing the word: only the boolean itself.
    expect(statusColumnKind("Suspend Reason")).toBe("status")
  })

  it("marks True amber and leaves False neutral", () => {
    for (const value of ["True", "true", "TRUE"]) {
      expect(cellTextClass("warn-when-true", value), value).toBe("text-amber-600 dark:text-amber-400")
    }
    for (const value of ["False", "false", "", "unknown"]) {
      expect(cellTextClass("warn-when-true", value), value).toBeNull()
    }
  })

  it("reads status columns exactly as statusTextClass does", () => {
    for (const value of ["Failed", "Pending", "Running", "True", "False", ""]) {
      expect(cellTextClass("status", value), value).toBe(statusTextClass(value))
    }
  })
})
