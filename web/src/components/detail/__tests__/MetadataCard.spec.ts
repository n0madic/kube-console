import { mount, type VueWrapper } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"

// Owner links resolve through discovery; only the annotations are under test.
vi.mock("@/composables/useDiscovery", () => ({
  useDiscovery: () => ({ findByKind: () => undefined }),
}))

import type { K8sObject } from "@/api/types"
import MetadataCard from "@/components/detail/MetadataCard.vue"

const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration"
// Short enough that the ordinary rule would print it whole.
const SHORT_SECRET = '{"stringData":{"password":"SENTINEL-pw"}}'
const LONG_SECRET = `{"data":{"token":"SENTINEL-${"x".repeat(300)}"}}`

function object(kind: string, uid: string, annotations: Record<string, string>): K8sObject {
  return { apiVersion: "v1", kind, metadata: { name: "db", namespace: "prod", uid, annotations } }
}

function mountCard(obj: K8sObject) {
  return mount(MetadataCard, {
    props: { object: obj },
    global: { stubs: { RouterLink: { props: ["to"], template: "<a><slot /></a>" } } },
  })
}

function toggle(wrapper: VueWrapper) {
  const found = wrapper.findAll("button").find((b) => /expand|collapse/.test(b.text()))
  if (found === undefined) throw new Error("no expand/collapse button")
  return found
}

describe("MetadataCard annotations", () => {
  it.each([
    ["short", SHORT_SECRET],
    ["long", LONG_SECRET],
  ])("hides a Secret's %s last-applied-configuration whole until expanded", async (_, value) => {
    const wrapper = mountCard(object("Secret", "s1", { [LAST_APPLIED]: value }))
    expect(wrapper.text()).not.toContain("SENTINEL")
    expect(wrapper.text()).not.toContain("stringData")
    expect(wrapper.text()).not.toContain('{"')
    expect(wrapper.text()).toContain("hidden: contains Secret data")

    await toggle(wrapper).trigger("click")
    expect(wrapper.text()).toContain("SENTINEL")

    await toggle(wrapper).trigger("click")
    expect(wrapper.text()).not.toContain("SENTINEL")
  })

  it("leaves other annotations of a Secret as they are", () => {
    const wrapper = mountCard(object("Secret", "s1", { owner: "team-a" }))
    expect(wrapper.text()).toContain("team-a")
    expect(wrapper.text()).not.toContain("hidden")
  })

  it("keeps the ordinary prefix truncation for other kinds", () => {
    const wrapper = mountCard(object("ConfigMap", "c1", { [LAST_APPLIED]: LONG_SECRET }))
    expect(wrapper.text()).toContain(LONG_SECRET.slice(0, 140))
    expect(wrapper.text()).not.toContain(LONG_SECRET)
    expect(wrapper.text()).not.toContain("hidden")
  })

  it("prints a short annotation of another kind whole", () => {
    const wrapper = mountCard(object("ConfigMap", "c1", { [LAST_APPLIED]: SHORT_SECRET }))
    expect(wrapper.text()).toContain(SHORT_SECRET)
  })

  // The card is reused across objects: an expansion on one Secret must not
  // reveal a same-keyed annotation on the next without a click.
  it("collapses again when the object changes", async () => {
    const wrapper = mountCard(object("Secret", "s1", { [LAST_APPLIED]: SHORT_SECRET }))
    await toggle(wrapper).trigger("click")
    expect(wrapper.text()).toContain("SENTINEL")

    await wrapper.setProps({ object: object("Secret", "s2", { [LAST_APPLIED]: SHORT_SECRET }) })
    expect(wrapper.text()).not.toContain("SENTINEL")
    expect(wrapper.text()).toContain("hidden: contains Secret data")
  })
})
