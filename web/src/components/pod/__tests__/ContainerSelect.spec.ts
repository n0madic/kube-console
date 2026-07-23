import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

import type { K8sObject } from "@/api/types"
import ContainerSelect from "@/components/pod/ContainerSelect.vue"

function pod(spec: Record<string, unknown>): K8sObject {
  return { kind: "Pod", metadata: { name: "p", namespace: "ns" }, spec }
}

const APP_ONLY = pod({ containers: [{ name: "app" }] })
const TWO_REGULAR = pod({ containers: [{ name: "app" }, { name: "sidecar" }] })
const APP_AND_INIT = pod({ containers: [{ name: "app" }], initContainers: [{ name: "init-db" }] })
const ALL_KINDS = pod({
  containers: [{ name: "app" }],
  initContainers: [{ name: "init-db" }],
  ephemeralContainers: [{ name: "debugger" }],
})

function mountSelect(object: K8sObject, modelValue = "app") {
  return mount(ContainerSelect, { props: { object, modelValue } })
}

describe("ContainerSelect", () => {
  // Ephemeral containers are `kubectl debug` targets — the way into an image
  // with no shell — and used to be missing from both pod tabs entirely.
  it("lists regular, ephemeral and init containers, in that order", () => {
    const wrapper = mountSelect(ALL_KINDS)

    expect(wrapper.findAll("option").map((o) => o.text())).toEqual(["app", "debugger", "init-db"])
    expect(wrapper.findAll("optgroup").map((g) => g.attributes("label"))).toEqual([
      "Containers",
      "Ephemeral containers",
      "Init containers",
    ])
  })

  // A lone "Containers" heading over a plain app pod's containers is noise.
  it("skips the grouping when the pod has only regular containers", () => {
    const wrapper = mountSelect(TWO_REGULAR)

    expect(wrapper.findAll("optgroup")).toHaveLength(0)
    expect(wrapper.findAll("option").map((o) => o.text())).toEqual(["app", "sidecar"])
  })

  // One container is not a choice: the control keeps its shape (the toolbar
  // does not gain a second one) but cannot be opened, and says why.
  it("locks itself, visibly, when the pod has a single container", () => {
    const wrapper = mountSelect(APP_ONLY)

    expect(wrapper.get("select").attributes("disabled")).toBeDefined()
    expect(wrapper.get("label").classes()).toContain("opacity-60")
    expect(wrapper.get("label").attributes("title")).toBe("The only container in this pod")
  })

  // Two regular containers is the common multi-container pod (app + sidecar)
  // and the case a miscounted `sole` would lock first; an init or ephemeral
  // one beside the app container is a real choice too — exec into a finished
  // init container fails, so it must stay pickable.
  it("stays open whenever there is more than one container", () => {
    expect(mountSelect(TWO_REGULAR).get("select").attributes("disabled")).toBeUndefined()
    expect(mountSelect(APP_AND_INIT).get("select").attributes("disabled")).toBeUndefined()
    expect(mountSelect(ALL_KINDS).get("select").attributes("disabled")).toBeUndefined()
  })

  // Both lock reasons can hold at once, and they differ in what the user can
  // do about them: a running session is the one to report.
  it("prefers the caller's lock reason over its own", () => {
    const wrapper = mount(ContainerSelect, {
      props: { object: APP_ONLY, modelValue: "app", disabled: true, title: "Disconnect first" },
    })

    expect(wrapper.get("label").attributes("title")).toBe("Disconnect first")
  })

  it("is a plain v-model over the container name", async () => {
    const wrapper = mountSelect(ALL_KINDS)
    await wrapper.get("select").setValue("debugger")

    expect(wrapper.emitted("update:modelValue")).toEqual([["debugger"]])
  })

  // Locked has to be visible: the Terminal tab holds this picker for the whole
  // session, and an undimmed select that ignores clicks reads as broken.
  it("disables the whole picker, visibly, while a session holds it", () => {
    const wrapper = mount(ContainerSelect, {
      props: { object: ALL_KINDS, modelValue: "app", disabled: true },
    })

    expect(wrapper.get("select").attributes("disabled")).toBeDefined()
    expect(wrapper.get("label").classes()).toContain("opacity-60")
    expect(mountSelect(ALL_KINDS).get("label").classes()).not.toContain("opacity-60")
  })
})
