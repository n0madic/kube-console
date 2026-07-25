import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/api/k8s", () => ({ listAllAsTable: vi.fn() }))

import { ApiError } from "@/api/http"
import { listAllAsTable, type TableWalkResult } from "@/api/k8s"
import type { K8sTable, K8sTableRow } from "@/api/types"
import ProblemPodsCard from "@/components/pod/ProblemPodsCard.vue"
import { STUCK_GRACE_MS } from "@/utils/podHealth"

const mockedList = vi.mocked(listAllAsTable)
const routerLinkStub = { RouterLink: { props: ["to"], template: "<a><slot /></a>" } }

const COLUMNS = [
  { name: "Name", type: "string" },
  { name: "Ready", type: "string" },
  { name: "Status", type: "string" },
  { name: "Restarts", type: "string" },
  { name: "Age", type: "string" },
  { name: "IP", type: "string", priority: 1 },
  { name: "Node", type: "string", priority: 1 },
]

function pod(
  namespace: string,
  name: string,
  ready: string,
  status: string,
  ageMs = STUCK_GRACE_MS * 2,
  node = "node-1",
): K8sTableRow {
  return {
    cells: [name, ready, status, "0", "1h", "10.0.0.1", node],
    object: {
      metadata: {
        name,
        namespace,
        creationTimestamp: new Date(Date.now() - ageMs).toISOString(),
      },
    },
  }
}

function table(rows: K8sTableRow[]): K8sTable {
  return { kind: "Table", columnDefinitions: COLUMNS, rows }
}

function mockScan(rows: K8sTableRow[], truncated = false): void {
  mockedList.mockResolvedValue({ table: table(rows), truncated })
}

// Every mounted card keeps a document-level visibilitychange listener until it
// is unmounted, so a leftover from an earlier test would answer this test's
// dispatch and consume its mocked responses.
const mounted: Array<ReturnType<typeof mount>> = []

function mountCard() {
  const wrapper = mount(ProblemPodsCard, { global: { stubs: routerLinkStub } })
  mounted.push(wrapper)
  return wrapper
}

describe("ProblemPodsCard", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedList.mockReset()
  })

  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
  })

  it("renders nothing when every pod is healthy", async () => {
    mockScan([pod("default", "web-1", "1/1", "Running"), pod("kube-system", "dns", "2/2", "Running")])
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.find("section").exists()).toBe(false)
    expect(wrapper.text()).toBe("")
  })

  it("lists only the problem pods, worst first, with their namespace", async () => {
    mockScan([
      pod("default", "healthy", "1/1", "Running"),
      pod("b-ns", "stuck-pod", "0/1", "Pending"),
      pod("a-ns", "unready", "1/2", "Running"),
      pod("c-ns", "crashing", "0/1", "CrashLoopBackOff"),
    ])
    const wrapper = mountCard()
    await flushPromises()

    const names = wrapper.findAll("tbody tr").map((tr) => tr.text())
    expect(names).toHaveLength(3)
    // error → not-ready → stuck
    expect(names[0]).toContain("crashing")
    expect(names[1]).toContain("unready")
    expect(names[2]).toContain("stuck-pod")
    expect(names[0]).toContain("c-ns")
    expect(wrapper.text()).toContain("Problem pods")
    expect(wrapper.text()).toContain("(3)")
    // The list-page columns plus Node (a wide one); IP stays out.
    const headers = wrapper.findAll("thead th").map((th) => th.text())
    expect(headers).toEqual(["Namespace", "Name", "Ready", "Status", "Restarts", "Age", "Node"])
    expect(names[0]).toContain("node-1")
  })

  it("caps the rendered rows and reports the full match count", async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      pod("default", `bad-${String(i).padStart(2, "0")}`, "0/1", "CrashLoopBackOff"),
    )
    mockScan(rows)
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.findAll("tbody tr")).toHaveLength(50)
    expect(wrapper.text()).toContain("50 of 60")
  })

  it("marks a truncated scan", async () => {
    mockScan([pod("default", "crashing", "0/1", "Error")], true)
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.text()).toContain("(1+)")
  })

  it("hides itself when listing pods cluster-wide is forbidden", async () => {
    mockedList.mockRejectedValue(new ApiError(403, "pods is forbidden"))
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.find("section").exists()).toBe(false)
  })

  it("surfaces other failures", async () => {
    mockedList.mockRejectedValue(new ApiError(500, "apiserver exploded"))
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.text()).toContain("apiserver exploded")
    expect(wrapper.find("tbody").exists()).toBe(false)
  })

  // Regression: the visibilitychange catch-up used to start a scan without
  // knowing one was already walking, and both carried the same live generation
  // — so the tab returning during a long walk left two self-sustaining chains,
  // permanently walking every pod in the cluster twice per interval. The
  // catch-up is throttled to the card's own 60s cadence, so reaching it needs a
  // scan still walking a minute later (a big cluster, a tab left in the
  // background) — hence the clock jump before the flip.
  it("does not start a second scan while one is still walking", async () => {
    let finishFirst: (result: TableWalkResult) => void = () => {}
    mockedList.mockReturnValueOnce(
      new Promise<TableWalkResult>((resolve) => {
        finishFirst = resolve
      }),
    )

    const wrapper = mountCard()
    const realNow = Date.now
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 2 * 60_000)
    document.dispatchEvent(new Event("visibilitychange"))
    await flushPromises()
    document.dispatchEvent(new Event("visibilitychange")) // a second return, same walk
    await flushPromises()
    clock.mockRestore()

    expect(mockedList).toHaveBeenCalledTimes(1)

    // The one walk still owns the state writes when it lands.
    finishFirst({ table: table([pod("a-ns", "only-scan", "0/1", "Error")]), truncated: false })
    await flushPromises()
    expect(wrapper.text()).toContain("only-scan")
  })

  // The Pods gauge draws its trouble segment from this count, so a scan that
  // proves nothing (403, failure) must report null, never 0.
  it("reports the match count upwards", async () => {
    mockScan([
      pod("default", "healthy", "1/1", "Running"),
      pod("a-ns", "crashing", "0/1", "CrashLoopBackOff"),
    ])
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.emitted("count")?.at(-1)).toEqual([1, false])
  })

  it("reports a capped scan's count as a floor", async () => {
    mockScan([pod("a-ns", "crashing", "0/1", "CrashLoopBackOff")], true)
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.emitted("count")?.at(-1)).toEqual([1, true])
  })

  it("reports an unknown count when the scan fails", async () => {
    mockedList.mockRejectedValue(new ApiError(403, "pods is forbidden"))
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.emitted("count")?.at(-1)).toEqual([null, false])
  })

  it("rescans on demand", async () => {
    mockScan([pod("default", "crashing", "0/1", "Error")])
    const wrapper = mountCard()
    await flushPromises()
    expect(mockedList).toHaveBeenCalledTimes(1)
    await wrapper.get("button").trigger("click")
    await flushPromises()
    expect(mockedList).toHaveBeenCalledTimes(2)
  })
})
