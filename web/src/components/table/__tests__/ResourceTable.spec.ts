import { mount } from "@vue/test-utils"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { K8sTableColumn, K8sTableRow } from "@/api/types"
import ResourceTable from "@/components/table/ResourceTable.vue"
import { listToTable } from "@/utils/tableFallback"

// Give the virtualizer a real viewport in jsdom.
const originalGetRect = Element.prototype.getBoundingClientRect
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 1024,
      height: 640,
      top: 0,
      left: 0,
      bottom: 640,
      right: 1024,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }
})
afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetRect
})

// RouterLink is resolved by the render function even when no cell links, so
// every mount needs the stub.
const stubs = { RouterLink: { props: ["to"], template: "<a><slot /></a>" } }

function mountTable(columns: K8sTableColumn[], rows: K8sTableRow[], globalFilter = "") {
  return mount(ResourceTable, {
    props: { columns, rows, globalFilter },
    global: { stubs },
  })
}

describe("ResourceTable", () => {
  it("renders native Table columnDefinitions and rows", () => {
    const wrapper = mountTable(
      [
        { name: "Name", type: "string" },
        { name: "Ready", type: "string" },
        { name: "Age", type: "string" },
      ],
      [
        { cells: ["api-1", "1/1", "5d"], object: { metadata: { name: "api-1", uid: "u1" } } },
        { cells: ["api-2", "0/1", "2h"], object: { metadata: { name: "api-2", uid: "u2" } } },
      ],
    )
    const headers = wrapper.findAll('[role="columnheader"]').map((h) => h.text())
    expect(headers.join(" ")).toContain("Name")
    expect(headers.join(" ")).toContain("Ready")
    expect(wrapper.text()).toContain("api-1")
    expect(wrapper.text()).toContain("0/1")
  })

  it("renders CRD additionalPrinterColumns dynamically", () => {
    const wrapper = mountTable(
      [
        { name: "Name", type: "string" },
        { name: "Replicas", type: "integer" },
        { name: "Custom Phase", type: "string" },
      ],
      [{ cells: ["my-cr", 3, "Synced"], object: { metadata: { name: "my-cr", uid: "u1" } } }],
    )
    const headers = wrapper.findAll('[role="columnheader"]').map((h) => h.text())
    expect(headers.some((h) => h.includes("Replicas"))).toBe(true)
    expect(headers.some((h) => h.includes("Custom Phase"))).toBe(true)
    expect(wrapper.text()).toContain("Synced")
    expect(wrapper.text()).toContain("3")
  })

  it("renders the List fallback conversion (Name/Namespace/Created/Status)", () => {
    const table = listToTable({
      items: [
        {
          metadata: { name: "cfg", namespace: "prod", creationTimestamp: "2026-07-01T00:00:00Z", uid: "u9" },
          status: { phase: "Active" },
        },
      ],
    })
    const wrapper = mountTable(table.columnDefinitions, table.rows ?? [])
    const headers = wrapper.findAll('[role="columnheader"]').map((h) => h.text())
    expect(headers.join(" ")).toContain("Namespace")
    expect(wrapper.text()).toContain("cfg")
    expect(wrapper.text()).toContain("Active")
  })

  it("emits rowClick with the original row", async () => {
    const wrapper = mountTable(
      [{ name: "Name", type: "string" }],
      [{ cells: ["api-1"], object: { metadata: { name: "api-1", uid: "u1" } } }],
    )
    const row = wrapper.findAll('[role="row"]')[1]
    expect(row).toBeDefined()
    await row!.trigger("click")
    const emitted = wrapper.emitted("rowClick")
    expect(emitted).toBeDefined()
    const clicked = emitted?.[0]?.[0] as K8sTableRow
    expect(clicked.object?.metadata?.name).toBe("api-1")
  })

  it("auto-hides columns where every value is <none>", () => {
    const wrapper = mountTable(
      [
        { name: "Name", type: "string" },
        { name: "Node", type: "string" },
        { name: "Nominated Node", type: "string" },
        { name: "Readiness Gates", type: "string" },
      ],
      [
        {
          cells: ["api-1", "node-a", "<none>", "<none>"],
          object: { metadata: { name: "api-1", uid: "u1" } },
        },
        {
          cells: ["api-2", "node-b", "<none>", "<none>"],
          object: { metadata: { name: "api-2", uid: "u2" } },
        },
      ],
    )
    const headers = wrapper.findAll('[role="columnheader"]').map((h) => h.text())
    expect(headers.some((h) => h.includes("Node"))).toBe(true)
    expect(headers.some((h) => h.includes("Nominated Node"))).toBe(false)
    expect(headers.some((h) => h.includes("Readiness Gates"))).toBe(false)
    expect(wrapper.text()).toContain("node-a")
  })

  it("keeps a column when at least one row has a real value", () => {
    const wrapper = mountTable(
      [
        { name: "Name", type: "string" },
        { name: "Nominated Node", type: "string" },
      ],
      [
        { cells: ["api-1", "<none>"], object: { metadata: { name: "api-1", uid: "u1" } } },
        { cells: ["api-2", "node-b"], object: { metadata: { name: "api-2", uid: "u2" } } },
      ],
    )
    const headers = wrapper.findAll('[role="columnheader"]').map((h) => h.text())
    expect(headers.some((h) => h.includes("Nominated Node"))).toBe(true)
  })

  it("never colors non-status columns even with alarm words in values", () => {
    const wrapper = mountTable(
      [
        { name: "Name", type: "string" },
        { name: "Selector", type: "string" },
        { name: "Status", type: "string" },
      ],
      [
        {
          cells: ["error-page-frontend", "app=failover", "Running"],
          object: { metadata: { name: "error-page-frontend", uid: "u1" } },
        },
      ],
    )
    const cells = wrapper.findAll('[role="cell"]')
    for (const cell of cells) {
      expect(cell.classes(), cell.text()).not.toContain("text-red-600")
    }
  })

  it("applies the red status class without a competing neutral color", () => {
    // Regression: a static text-slate-700 class used to win over text-red-600
    // because of Tailwind's stylesheet order, so Failed looked neutral.
    const wrapper = mountTable(
      [
        { name: "Name", type: "string" },
        { name: "Status", type: "string" },
      ],
      [{ cells: ["job-1", "Failed"], object: { metadata: { name: "job-1", uid: "u1" } } }],
    )
    const failedCell = wrapper
      .findAll('[role="cell"]')
      .find((c) => c.text() === "Failed")
    expect(failedCell).toBeDefined()
    expect(failedCell!.classes()).toContain("text-red-600")
    expect(failedCell!.classes()).not.toContain("text-slate-700")
  })

  it("applies the default sort (events newest first by Last Seen)", () => {
    const wrapper = mount(ResourceTable, {
      props: {
        columns: [
          { name: "Last Seen", type: "string" },
          { name: "Reason", type: "string" },
        ],
        rows: [
          { cells: ["44d", "Old"], object: { metadata: { name: "e1", uid: "u1" } } },
          { cells: ["30s", "Newest"], object: { metadata: { name: "e2", uid: "u2" } } },
          { cells: ["5m", "Recent"], object: { metadata: { name: "e3", uid: "u3" } } },
        ],
        globalFilter: "",
        defaultSort: { column: "Last Seen", desc: false },
      },
      global: { stubs },
    })
    const cells = wrapper.findAll('[role="cell"]').map((c) => c.text())
    expect(cells.indexOf("Newest")).toBeLessThan(cells.indexOf("Recent"))
    expect(cells.indexOf("Recent")).toBeLessThan(cells.indexOf("Old"))
  })

  it("sorts pods newest first by ascending Age", () => {
    // Freshest pods (smallest age) on top — the pods list-page default.
    const wrapper = mount(ResourceTable, {
      props: {
        columns: [
          { name: "Name", type: "string" },
          { name: "Age", type: "string" },
        ],
        rows: [
          { cells: ["old", "44d"], object: { metadata: { name: "old", uid: "u1" } } },
          { cells: ["fresh", "30s"], object: { metadata: { name: "fresh", uid: "u2" } } },
          { cells: ["mid", "5m"], object: { metadata: { name: "mid", uid: "u3" } } },
        ],
        globalFilter: "",
        defaultSort: { column: "Age", desc: false },
      },
      global: { stubs },
    })
    const cells = wrapper.findAll('[role="cell"]').map((c) => c.text())
    expect(cells.indexOf("fresh")).toBeLessThan(cells.indexOf("mid"))
    expect(cells.indexOf("mid")).toBeLessThan(cells.indexOf("old"))
  })

  it("sorts by Name by default when requested", () => {
    const wrapper = mount(ResourceTable, {
      props: {
        columns: [
          { name: "Name", type: "string" },
          { name: "Status", type: "string" },
        ],
        rows: [
          { cells: ["zeta", "Running"], object: { metadata: { name: "zeta", uid: "u1" } } },
          { cells: ["alpha", "Running"], object: { metadata: { name: "alpha", uid: "u2" } } },
          { cells: ["mid", "Running"], object: { metadata: { name: "mid", uid: "u3" } } },
        ],
        globalFilter: "",
        defaultSort: { column: "Name", desc: false },
      },
      global: { stubs },
    })
    const cells = wrapper.findAll('[role="cell"]').map((c) => c.text())
    expect(cells.indexOf("alpha")).toBeLessThan(cells.indexOf("mid"))
    expect(cells.indexOf("mid")).toBeLessThan(cells.indexOf("zeta"))
  })

  it("sizes visible columns by their own data when a middle column is hidden", () => {
    // Regression: estimateColumnWidths was fed the visible subset but indexed
    // row.cells by visible position, so columns after a hidden non-trailing one
    // inherited the wrong column's width.
    const longVal = "x".repeat(120)
    const wrapper = mount(ResourceTable, {
      props: {
        columns: [
          { name: "Name", type: "string" },
          { name: "Middle", type: "string" },
          { name: "After", type: "string" },
        ],
        rows: [
          { cells: ["a", longVal, "s"], object: { metadata: { name: "a", uid: "u1" } } },
          { cells: ["b", longVal, "s"], object: { metadata: { name: "b", uid: "u2" } } },
        ],
        globalFilter: "",
        hiddenColumns: ["Middle"],
      },
      global: { stubs },
    })
    const after = wrapper
      .findAll('[role="columnheader"]')
      .find((h) => h.text().includes("After"))
    expect(after).toBeDefined()
    const width = parseFloat(/width:\s*([\d.]+)px/.exec(after!.attributes("style") ?? "")?.[1] ?? "0")
    // "After" holds only "s"; its width must stay small, not inherit the hidden
    // long "Middle" column's (which would clamp near COLUMN_MAX_PX = 380).
    expect(width).toBeGreaterThan(0)
    expect(width).toBeLessThan(120)
  })

  it("shows Loading, not 'No resources found', while an empty list loads", () => {
    // Regression: navigating to a resource showed "No resources found." during
    // the load, which looked like the resource was empty on slow clusters.
    const wrapper = mount(ResourceTable, {
      props: { columns: [{ name: "Name", type: "string" }], rows: [], globalFilter: "", loading: true },
      global: { stubs },
    })
    expect(wrapper.text()).toContain("Loading…")
    expect(wrapper.text()).not.toContain("No resources found")
  })

  it("shows 'No resources found' once an empty load settles", () => {
    const wrapper = mount(ResourceTable, {
      props: { columns: [{ name: "Name", type: "string" }], rows: [], globalFilter: "", loading: false },
      global: { stubs },
    })
    expect(wrapper.text()).toContain("No resources found")
    expect(wrapper.text()).not.toContain("Loading…")
  })

  it("renders a cellLink cell as a link that does not trigger the row click", async () => {
    const wrapper = mount(ResourceTable, {
      props: {
        columns: [
          { name: "Reason", type: "string" },
          { name: "Object", type: "string" },
        ],
        rows: [
          {
            cells: ["Killing", "pod/nginx-abc"],
            object: { metadata: { name: "e1", namespace: "prod", uid: "u1" } },
          },
        ],
        globalFilter: "",
        cellLink: (_row, column, value) =>
          column === "Object" ? { path: `/r/core/v1/pods/prod/${value.split("/")[1]}` } : null,
      },
      global: { stubs },
    })
    const links = wrapper.findAll("a")
    expect(links).toHaveLength(1)
    expect(links[0]!.text()).toBe("pod/nginx-abc")
    // Plain columns stay plain text.
    expect(wrapper.text()).toContain("Killing")

    await links[0]!.trigger("click")
    expect(wrapper.emitted("rowClick")).toBeUndefined()
  })

  it("renders plain cells when no cellLink is given", () => {
    const wrapper = mountTable(
      [
        { name: "Reason", type: "string" },
        { name: "Object", type: "string" },
      ],
      [{ cells: ["Killing", "pod/nginx-abc"], object: { metadata: { name: "e1", uid: "u1" } } }],
    )
    expect(wrapper.findAll("a")).toHaveLength(0)
    expect(wrapper.text()).toContain("pod/nginx-abc")
  })

  it("filters rows on the current page", () => {
    const wrapper = mountTable(
      [{ name: "Name", type: "string" }],
      [
        { cells: ["alpha"], object: { metadata: { name: "alpha", uid: "u1" } } },
        { cells: ["beta"], object: { metadata: { name: "beta", uid: "u2" } } },
      ],
      "alp",
    )
    expect(wrapper.text()).toContain("alpha")
    expect(wrapper.text()).not.toContain("beta")
  })
})
