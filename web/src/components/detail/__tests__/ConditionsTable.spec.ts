import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

import type { K8sObject } from "@/api/types"
import ConditionsTable from "@/components/detail/ConditionsTable.vue"

function mountWith(conditions: Array<Record<string, unknown>>) {
  const object: K8sObject = { status: { conditions } }
  return mount(ConditionsTable, { props: { object } })
}

function statusCellClass(wrapper: ReturnType<typeof mountWith>, type: string): string[] {
  const row = wrapper.findAll("tbody tr").find((r) => r.text().includes(type))
  expect(row, `row for ${type}`).toBeDefined()
  // Columns: Type, Status, Reason, Age, Message → Status is the 2nd cell.
  return row!.findAll("td")[1]!.classes()
}

describe("ConditionsTable status polarity", () => {
  it("colors a positive condition (Ready=True) green", () => {
    const w = mountWith([{ type: "Ready", status: "True" }])
    expect(statusCellClass(w, "Ready")).toContain("text-green-600")
  })

  it("colors a negative condition (DiskPressure=True) red, not green", () => {
    const w = mountWith([{ type: "DiskPressure", status: "True" }])
    const classes = statusCellClass(w, "DiskPressure")
    expect(classes).toContain("text-red-600")
    expect(classes).not.toContain("text-green-600")
  })

  it("colors a negative condition (NetworkUnavailable=False) green", () => {
    const w = mountWith([{ type: "NetworkUnavailable", status: "False" }])
    expect(statusCellClass(w, "NetworkUnavailable")).toContain("text-green-600")
  })

  it("uses a dark-mode variant for the neutral color", () => {
    const w = mountWith([{ type: "Ready", status: "Unknown" }])
    expect(statusCellClass(w, "Ready")).toContain("dark:text-slate-400")
  })
})
