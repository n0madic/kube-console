import { flushPromises, mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"

// The real editor is a lazy CodeMirror chunk; the tab's own behaviour is which
// text it hands over, so stand in a component that just renders the model.
// __esModule is what makes defineAsyncComponent unwrap `default` instead of
// treating the module namespace itself as the component.
vi.mock("@/components/detail/CodeMirrorEditor.vue", () => ({
  __esModule: true,
  default: {
    name: "CodeMirrorEditor",
    props: { modelValue: { type: String, required: true }, readonly: Boolean },
    template: "<pre>{{ modelValue }}</pre>",
  },
}))

import type { K8sObject } from "@/api/types"
import YamlTab from "@/components/detail/YamlTab.vue"

function objectWithManagedFields(): K8sObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "web",
      namespace: "prod",
      managedFields: [
        { manager: "kubelet", operation: "Update", apiVersion: "v1", subresource: "status" },
      ],
    },
    spec: { containers: [{ name: "app", image: "nginx" }] },
  }
}

async function mountTab(object: K8sObject) {
  const wrapper = mount(YamlTab, { props: { object } })
  await flushPromises() // resolve the async editor
  return wrapper
}

describe("YamlTab", () => {
  it("hides managedFields by default and reveals them on the toggle", async () => {
    const wrapper = await mountTab(objectWithManagedFields())

    expect(wrapper.text()).toContain("name: web")
    expect(wrapper.find("pre").text()).not.toContain("managedFields")

    await wrapper.find("input[type=checkbox]").setValue(true)
    expect(wrapper.find("pre").text()).toContain("managedFields")
    expect(wrapper.find("pre").text()).toContain("kubelet")
  })

  // The hidden view is built from a clone: the detail page keeps handing the
  // same object to every other tab and to its actions.
  it("does not mutate the object it renders", async () => {
    const object = objectWithManagedFields()
    await mountTab(object)
    expect(object.metadata?.managedFields).toHaveLength(1)
  })

  it("re-renders when the page hands over a refreshed object", async () => {
    const wrapper = await mountTab(objectWithManagedFields())
    const next = objectWithManagedFields()
    next.metadata!.name = "web-2"
    await wrapper.setProps({ object: next })
    expect(wrapper.find("pre").text()).toContain("name: web-2")
  })
})
