import { describe, expect, it } from "vitest"

import { isStatusColumn, statusTextClass } from "@/utils/statusColors"

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

  it("leaves neutral values unstyled", () => {
    for (const value of ["Running", "Active", "Completed", "1/1", "5d", "api-server-1", "", "True", "False"]) {
      expect(statusTextClass(value), value).toBeNull()
    }
  })
})
