import { flushPromises, mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/api/k8s", () => ({ eventsFor: vi.fn() }))

import { eventsFor } from "@/api/k8s"
import type { K8sObject, K8sObjectList } from "@/api/types"
import EventsCard from "@/components/detail/EventsCard.vue"

const mockedEventsFor = vi.mocked(eventsFor)

const object: K8sObject = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "web-1", namespace: "default", uid: "u1" },
}

function eventList(): K8sObjectList {
  return {
    items: [
      {
        metadata: { uid: "e1", creationTimestamp: "2026-07-20T10:00:00Z" },
        type: "Warning",
        reason: "BackOff",
        message: "Back-off restarting failed container",
        count: 5,
        source: { component: "kubelet" },
        lastTimestamp: "2026-07-20T10:00:00Z",
      },
    ] as K8sObjectList["items"],
  }
}

function mountFor(obj: K8sObject) {
  // The card catches load errors itself; an errorHandler keeps Vue's dev-mode
  // rethrow of the async-hook rejection from surfacing as an unhandled rejection
  // (which vitest would fail the test on).
  return mount(EventsCard, {
    props: { object: obj },
    global: { config: { errorHandler: () => {} } },
  })
}

// No beforeEach reset: each test sets its own mock implementation, and calling
// mockClear/mockReset in a beforeEach here spuriously trips vitest's
// unhandled-rejection tracking on the reject test even though the component
// handles the error.
describe("EventsCard", () => {
  it("renders the events table with a count when events exist", async () => {
    mockedEventsFor.mockResolvedValue(eventList())
    const wrapper = mountFor(object)
    await flushPromises()

    expect(wrapper.find("section").exists()).toBe(true)
    expect(wrapper.text()).toContain("Events")
    expect(wrapper.text()).toContain("(1)")
    expect(wrapper.text()).toContain("BackOff")
    expect(wrapper.text()).toContain("kubelet")
  })

  it("renders nothing when the object has no events", async () => {
    mockedEventsFor.mockResolvedValue({ items: [] })
    const wrapper = mountFor(object)
    await flushPromises()
    expect(wrapper.find("section").exists()).toBe(false)
  })

  // Regression: items:null (Go nil-slice marshaling from a nonstandard
  // server) crashed into the error banner instead of the empty state.
  it("treats items:null as an empty list, not an error", async () => {
    mockedEventsFor.mockResolvedValue({ items: null } as unknown as K8sObjectList)
    const wrapper = mountFor(object)
    await flushPromises()
    expect(wrapper.find("section").exists()).toBe(false)
    expect(wrapper.text()).not.toContain("Cannot load events")
  })

  // Regression: keyed on metadata.uid, an explicit refresh of the same object
  // (Refresh button, kind-specific action) left the events stale.
  it("reloads when the page hands over a refreshed object with the same uid", async () => {
    mockedEventsFor.mockResolvedValue(eventList())
    const wrapper = mountFor(object)
    await flushPromises()
    const before = mockedEventsFor.mock.calls.length

    await wrapper.setProps({ object: { ...object } })
    await flushPromises()
    expect(mockedEventsFor.mock.calls.length).toBe(before + 1)
  })

  it("surfaces a load error instead of swallowing it", async () => {
    // Lazy reject (fresh promise per call, handler attached synchronously by the
    // component's await); mockRejectedValue pre-creates the rejected promise,
    // which vitest counts as unhandled before the await can attach.
    mockedEventsFor.mockImplementation(() => Promise.reject(new Error("boom")))
    const wrapper = mountFor(object)
    await flushPromises()
    expect(wrapper.find("section").exists()).toBe(true)
    expect(wrapper.text()).toContain("Cannot load events")
  })
})
