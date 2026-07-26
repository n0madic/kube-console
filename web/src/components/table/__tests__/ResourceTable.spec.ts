import { mount } from "@vue/test-utils"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { K8sTableColumn, K8sTableRow } from "@/api/types"
import ResourceTable from "@/components/table/ResourceTable.vue"
import { listToTable } from "@/utils/tableFallback"

// Captures the options object handed to useVueTable so the `columns` getter's
// identity can be observed from a test; the real implementation still runs.
const captured = vi.hoisted(() => ({ options: undefined as { columns: unknown } | undefined }))
vi.mock("@tanstack/vue-table", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/vue-table")>()
  const useVueTable: typeof actual.useVueTable = (options) => {
    captured.options = options as unknown as { columns: unknown }
    return actual.useVueTable(options)
  }
  return { ...actual, useVueTable }
})

// Give the virtualizer a real viewport in jsdom. getBoundingClientRect covers
// the initial mount; virtual-core measures the attached scroll element with
// offsetWidth/offsetHeight (always 0 in jsdom, which has no layout), so those
// need stubbing too or every re-render after mount collapses to zero rows —
// and any post-update row assertion passes vacuously.
const originalGetRect = Element.prototype.getBoundingClientRect
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!
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
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 1024,
  })
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 640,
  })
})
afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetRect
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth)
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight)
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

// The rendered cells, asserted non-empty first: the virtualizer renders zero
// rows whenever the layout stubs above stop working, and every assertion over
// the result would then pass against an empty DOM.
function renderedCells(wrapper: ReturnType<typeof mountTable>) {
  const found = wrapper.findAll('[role="cell"]')
  expect(found.length, "expected rendered rows, got none").toBeGreaterThan(0)
  return found
}

// A light- or dark-mode text color utility (text-red-600, dark:text-slate-300),
// as opposed to text-sm / truncate.
const COLOR_CLASS_RE = /^text-[a-z]+-\d{3}$/
const DARK_COLOR_CLASS_RE = /^dark:text-[a-z]+-\d{3}$/

const NAME_AND_STATUS: K8sTableColumn[] = [
  { name: "Name", type: "string" },
  { name: "Status", type: "string" },
]

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

  // The class is resolved once per row per column set inside the cell-view memo
  // rather than per rendered cell; these pin the classification end to end,
  // since a memo is exactly what would freeze a stale color on screen.
  it("colors status cells by severity and leaves neutral ones on the fallback", () => {
    const wrapper = mountTable(NAME_AND_STATUS, [
      { cells: ["job-1", "Failed"], object: { metadata: { name: "job-1", uid: "u1" } } },
      { cells: ["job-2", "Pending"], object: { metadata: { name: "job-2", uid: "u2" } } },
      { cells: ["job-3", "Running"], object: { metadata: { name: "job-3", uid: "u3" } } },
    ])
    const classesByText = new Map(renderedCells(wrapper).map((c) => [c.text(), c.classes()]))
    expect(classesByText.get("Failed")).toContain("text-red-600")
    expect(classesByText.get("Pending")).toContain("text-amber-600")
    expect(classesByText.get("Running")).toContain("text-slate-700")
  })

  it("keeps a non-status column neutral even when the value reads like an error", () => {
    const wrapper = mountTable(NAME_AND_STATUS, [
      { cells: ["error-page", "Running"], object: { metadata: { name: "error-page", uid: "u1" } } },
    ])
    const name = renderedCells(wrapper).find((c) => c.text() === "error-page")
    expect(name).toBeDefined()
    expect(name!.classes()).toContain("text-slate-700")
    expect(name!.classes()).not.toContain("text-red-600")
  })

  it("colors a comma-joined Node status by its worst part", () => {
    // kubectl's Node printer joins the condition list, so a cordoned NotReady
    // node used to render exactly like a healthy one.
    const wrapper = mountTable(NAME_AND_STATUS, [
      {
        cells: ["node-a", "NotReady,SchedulingDisabled"],
        object: { metadata: { name: "node-a", uid: "u1" } },
      },
      {
        cells: ["node-b", "Ready,SchedulingDisabled"],
        object: { metadata: { name: "node-b", uid: "u2" } },
      },
    ])
    const classesByText = new Map(renderedCells(wrapper).map((c) => [c.text(), c.classes()]))
    expect(classesByText.get("NotReady,SchedulingDisabled")).toContain("text-red-600")
    expect(classesByText.get("Ready,SchedulingDisabled")).toContain("text-amber-600")
  })

  it("gives every cell exactly one text color utility, never two competing ones", () => {
    // Tailwind resolves by stylesheet order, not class order, so the neutral
    // fallback must be baked into the same single class expression.
    const wrapper = mountTable(NAME_AND_STATUS, [
      { cells: ["job-1", "Failed"], object: { metadata: { name: "job-1", uid: "u1" } } },
      { cells: ["job-2", "Running"], object: { metadata: { name: "job-2", uid: "u2" } } },
    ])
    for (const cell of renderedCells(wrapper)) {
      const classes = cell.classes()
      expect(classes.filter((c) => COLOR_CLASS_RE.test(c)), cell.text()).toHaveLength(1)
      expect(classes.filter((c) => DARK_COLOR_CLASS_RE.test(c)), cell.text()).toHaveLength(1)
    }
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
        defaultSort: { column: "Last Seen" },
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
        defaultSort: { column: "Age" },
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
        defaultSort: { column: "Name" },
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

  // The cell/route pairs are memoized per row — a virtualized table rebuilt
  // them on every scroll frame. Row identity covers the data (TanStack rebuilds
  // rows exactly when it changes); the column set does not, since the same rows
  // keep their identity while which cells are visible changes under them, so it
  // invalidates the memo by hand.
  it("re-resolves routes when the column set changes under the same rows", async () => {
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
        cellLink: (_row, column) => (column === "Object" ? { path: "/r/core/v1/pods" } : null),
      },
      global: { stubs },
    })
    expect(wrapper.findAll("a")).toHaveLength(1)

    await wrapper.setProps({ columns: [{ name: "Reason", type: "string" }] })
    expect(wrapper.findAll("a")).toHaveLength(0)
    expect(wrapper.text()).not.toContain("pod/nginx-abc")
  })

  // The defs feed useVueTable's `columns` getter, and every watch event
  // replaces props.rows — a fresh defs identity per event made TanStack
  // rebuild every column and the derived row model once per event, and reset
  // the cell-view memo with it.
  it("keeps the column defs identity across a rows-only update", async () => {
    const wrapper = mountTable(
      [
        { name: "Name", type: "string" },
        { name: "Status", type: "string" },
      ],
      [
        { cells: ["a", "Running"], object: { metadata: { name: "a", uid: "u1" } } },
        { cells: ["b", "Running"], object: { metadata: { name: "b", uid: "u2" } } },
      ],
    )
    const before = captured.options?.columns
    expect(before).toBeDefined()

    // A watch event: same column set, new rows array.
    await wrapper.setProps({
      rows: [
        { cells: ["a", "Running"], object: { metadata: { name: "a", uid: "u1" } } },
        { cells: ["c", "Pending"], object: { metadata: { name: "c", uid: "u3" } } },
      ],
    })
    expect(captured.options?.columns).toBe(before)

    // A column-set change must still yield new defs (and drop the memo).
    await wrapper.setProps({ columns: [{ name: "Name", type: "string" }] })
    expect(captured.options?.columns).not.toBe(before)
  })

  it("serves cell routes from the memo on re-renders, re-resolving on a column-set change", async () => {
    const cellLink = vi.fn(() => null)
    const wrapper = mount(ResourceTable, {
      props: {
        columns: [
          { name: "Reason", type: "string" },
          { name: "Object", type: "string" },
        ],
        rows: [
          { cells: ["Killing", "pod/nginx-abc"], object: { metadata: { name: "e1", uid: "u1" } } },
        ],
        globalFilter: "",
        cellLink,
      },
      global: { stubs },
    })
    const initialCalls = cellLink.mock.calls.length
    expect(initialCalls).toBeGreaterThan(0)

    // A re-render with unchanged rows and columns is served from the memo.
    await wrapper.setProps({ loading: true })
    expect(cellLink.mock.calls.length).toBe(initialCalls)

    // A changed column set drops it: the remaining cells re-resolve.
    await wrapper.setProps({ columns: [{ name: "Reason", type: "string" }] })
    expect(cellLink.mock.calls.length).toBeGreaterThan(initialCalls)
  })

  // The memo also holds each cell's resolved color class, and whether a column
  // carries statuses is derived from columnDefs — so the same rows, keeping
  // their Row identity, must be re-colored when the column set changes under
  // them. Without columnDefs in the invalidation the cell stays neutral.
  it("re-colors cells when the column set changes under the same rows", async () => {
    const rows: K8sTableRow[] = [
      { cells: ["svc-1", "Failed"], object: { metadata: { name: "svc-1", uid: "u1" } } },
    ]
    const wrapper = mount(ResourceTable, {
      props: {
        columns: [
          { name: "Name", type: "string" },
          { name: "Detail", type: "string" },
        ],
        rows,
        globalFilter: "",
      },
      global: { stubs },
    })
    const before = renderedCells(wrapper).find((c) => c.text() === "Failed")
    expect(before).toBeDefined()
    expect(before!.classes()).toContain("text-slate-700")

    // Same rows array (same Row objects), same values — only the column at
    // index 1 is now a status column.
    await wrapper.setProps({
      columns: [
        { name: "Name", type: "string" },
        { name: "Phase", type: "string" },
      ],
    })
    const after = renderedCells(wrapper).find((c) => c.text() === "Failed")
    expect(after).toBeDefined()
    expect(after!.classes()).toContain("text-red-600")
    expect(after!.classes()).not.toContain("text-slate-700")
  })

  it("re-resolves routes when cellLink changes under the same rows and columns", async () => {
    const columns: K8sTableColumn[] = [
      { name: "Reason", type: "string" },
      { name: "Object", type: "string" },
    ]
    const rows: K8sTableRow[] = [
      { cells: ["Killing", "pod/nginx-abc"], object: { metadata: { name: "e1", uid: "u1" } } },
    ]
    const wrapper = mount(ResourceTable, {
      props: { columns, rows, globalFilter: "", cellLink: () => null },
      global: { stubs },
    })
    expect(renderedCells(wrapper).length).toBeGreaterThan(0)
    expect(wrapper.findAll("a")).toHaveLength(0)

    await wrapper.setProps({
      cellLink: (_row: K8sTableRow, column: string) =>
        column === "Object" ? { path: "/r/core/v1/pods" } : null,
    })
    expect(wrapper.findAll("a")).toHaveLength(1)
    expect(wrapper.findAll("a")[0]!.text()).toBe("pod/nginx-abc")
  })

  // Row identity is what covers the cached text and class: a watch event
  // replaces the rows array, TanStack rebuilds the rows and the memo misses.
  it("updates cell text, title and color on a rows-only update", async () => {
    const wrapper = mountTable(NAME_AND_STATUS, [
      { cells: ["job-1", "Running"], object: { metadata: { name: "job-1", uid: "u1" } } },
    ])
    const before = renderedCells(wrapper).find((c) => c.text() === "Running")
    expect(before).toBeDefined()
    expect(before!.classes()).toContain("text-slate-700")

    await wrapper.setProps({
      rows: [{ cells: ["job-1", "Failed"], object: { metadata: { name: "job-1", uid: "u1" } } }],
    })
    const after = renderedCells(wrapper).find((c) => c.text() === "Failed")
    expect(after).toBeDefined()
    expect(after!.attributes("title")).toBe("Failed")
    expect(after!.classes()).toContain("text-red-600")
    expect(renderedCells(wrapper).some((c) => c.text() === "Running")).toBe(false)
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
