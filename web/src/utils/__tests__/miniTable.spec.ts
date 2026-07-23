import { describe, expect, it } from "vitest"

import type { K8sTable } from "@/api/types"
import { tableToMini } from "@/utils/miniTable"

const rsTable: K8sTable = {
  kind: "Table",
  columnDefinitions: [
    { name: "Name", type: "string" },
    { name: "Desired", type: "integer" },
    { name: "Current", type: "integer" },
    { name: "Ready", type: "integer" },
    { name: "Age", type: "string" },
    { name: "Containers", type: "string", priority: 1 },
    { name: "Images", type: "string", priority: 1 },
    { name: "Selector", type: "string", priority: 1 },
  ],
  rows: [
    {
      cells: ["web-abc", 3, 3, 3, "5d", "app", "nginx", "app=web"],
      object: {
        metadata: {
          name: "web-abc",
          namespace: "prod",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "dep-1" }],
        },
      },
    },
    {
      cells: ["web-old", 0, 0, 0, "20d", "app", "nginx:old", "app=web"],
      object: {
        metadata: {
          name: "web-old",
          namespace: "prod",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "other" }],
        },
      },
    },
  ],
}

describe("tableToMini", () => {
  it("keeps priority-0 columns, drops Name and wide columns", () => {
    const mini = tableToMini(rsTable)
    expect(mini.columns).toEqual(["Desired", "Current", "Ready", "Age"])
    expect(mini.rows[0]).toMatchObject({
      name: "web-abc",
      namespace: "prod",
      cells: ["3", "3", "3", "5d"],
    })
  })

  it("filters rows by ownerReferences via rowFilter", () => {
    const mini = tableToMini(rsTable, {
      rowFilter: (m) => (m.ownerReferences ?? []).some((o) => o.uid === "dep-1"),
    })
    expect(mini.rows).toHaveLength(1)
    expect(mini.rows[0]?.name).toBe("web-abc")
  })

  it("honors keepOnly including wide columns, in the given order", () => {
    const podTable: K8sTable = {
      kind: "Table",
      columnDefinitions: [
        { name: "Name", type: "string" },
        { name: "Ready", type: "string" },
        { name: "Status", type: "string" },
        { name: "IP", type: "string", priority: 1 },
        { name: "Node", type: "string", priority: 1 },
      ],
      rows: [
        {
          cells: ["p1", "1/1", "Running", "10.0.0.1", "node-1"],
          object: { metadata: { name: "p1", namespace: "default" } },
        },
      ],
    }
    const mini = tableToMini(podTable, { keepOnly: ["Ready", "Status", "IP"] })
    expect(mini.columns).toEqual(["Ready", "Status", "IP"])
    expect(mini.rows[0]?.cells).toEqual(["1/1", "Running", "10.0.0.1"])
  })

  it("drops named columns and coerces null/object cells to empty", () => {
    const table: K8sTable = {
      kind: "Table",
      columnDefinitions: [
        { name: "Name", type: "string" },
        { name: "Status", type: "string" },
        { name: "Note", type: "string" },
      ],
      rows: [{ cells: ["x", null, { a: 1 }], object: { metadata: { name: "x", namespace: "ns" } } }],
    }
    const mini = tableToMini(table, { drop: ["Note"] })
    expect(mini.columns).toEqual(["Status"])
    expect(mini.rows[0]?.cells).toEqual([""])
  })
})
