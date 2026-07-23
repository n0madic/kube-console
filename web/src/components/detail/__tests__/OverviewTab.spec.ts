import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"

// ObjectFieldTree resolves object references through discovery; the tree
// itself is under test here, not the lookup.
const findByKind = vi.fn(() => undefined)
const findByLowerKind = vi.fn(() => undefined)
vi.mock("@/composables/useDiscovery", () => ({
  useDiscovery: () => ({ findByKind, findByLowerKind }),
}))

import type { K8sObject } from "@/api/types"
import ConditionsTable from "@/components/detail/ConditionsTable.vue"
import ObjectFieldTree from "@/components/detail/ObjectFieldTree.vue"
import OverviewTab from "@/components/detail/OverviewTab.vue"

// Stub the data-fetching / router-bound children; only the Conditions/Status
// interplay is under test here.
const stubs = {
  MetadataCard: true,
  RelatedResourcesCard: true,
  SecretDataPanel: true,
  ConfigMapDataPanel: true,
  EventsCard: true,
}

function mountOverview(object: K8sObject) {
  return mount(OverviewTab, {
    props: { object },
    global: { stubs: { ...stubs, RouterLink: { props: ["to"], template: "<a><slot /></a>" } } },
  })
}

describe("OverviewTab Details card", () => {
  it("renders top-level fields (Event) that belong to no other card", () => {
    const event = {
      apiVersion: "v1",
      kind: "Event",
      metadata: { name: "nginx.17f", namespace: "prod" },
      type: "Warning",
      message: "Back-off restarting failed container",
    } as unknown as K8sObject
    const wrapper = mountOverview(event)
    expect(wrapper.text()).toContain("Details")
    expect(wrapper.text()).toContain("Warning")
    expect(wrapper.text()).toContain("Back-off restarting failed container")
  })

  it("stays hidden when everything lives in spec/status", () => {
    const pod: K8sObject = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "nginx" },
      spec: { nodeName: "node-a" },
    }
    expect(mountOverview(pod).text()).not.toContain("Details")
  })
})

describe("OverviewTab conditions/status interplay", () => {
  it("hides the status field tree when conditions carry only ConditionsTable columns", () => {
    const object: K8sObject = {
      apiVersion: "v1",
      kind: "Pod",
      status: {
        conditions: [{ type: "Ready", status: "True", reason: "PodReady" }],
      },
    }
    const wrapper = mountOverview(object)
    // Conditions rendered by the dedicated table...
    expect(wrapper.findComponent(ConditionsTable).text()).toContain("Ready")
    // ...and not duplicated as a raw field tree below.
    expect(wrapper.findComponent(ObjectFieldTree).exists()).toBe(false)
  })

  it("keeps conditions in the field tree when they carry extra CRD fields", () => {
    const object: K8sObject = {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      status: {
        conditions: [
          { type: "Ready", status: "True", observedGeneration: 7 },
        ],
      },
    }
    const wrapper = mountOverview(object)
    const tree = wrapper.findComponent(ObjectFieldTree)
    expect(tree.exists()).toBe(true)
    // The field ConditionsTable never shows must remain visible.
    expect(tree.text()).toContain("Observed Generation")
    expect(tree.text()).toContain("7")
  })
})
