import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { parse } from "yaml"

// The real editor is a lazy CodeMirror chunk; the tab's own behaviour is which
// text it hands over and what it does with edits, so stand in a component that
// renders the model and emits on input — a <pre> could never be typed into.
// __esModule is what makes defineAsyncComponent unwrap `default` instead of
// treating the module namespace itself as the component.
vi.mock("@/components/detail/CodeMirrorEditor.vue", () => ({
  __esModule: true,
  default: {
    name: "CodeMirrorEditor",
    props: { modelValue: { type: String, required: true }, readonly: Boolean },
    emits: ["update:modelValue"],
    template: `<textarea :readonly="readonly" :value="modelValue"
      @input="$emit('update:modelValue', $event.target.value)"></textarea>`,
  },
}))
vi.mock("@/api/k8s", () => ({ serverSideApply: vi.fn() }))

import { ApiError } from "@/api/http"
import { serverSideApply } from "@/api/k8s"
import type { K8sObject, ResourceRef } from "@/api/types"
import YamlTab from "@/components/detail/YamlTab.vue"
import { useToastStore } from "@/stores/toasts"
import { encodeBase64Utf8 } from "@/utils/base64"

const mockedApply = vi.mocked(serverSideApply)

const podRef: ResourceRef = { group: "", version: "v1", resource: "pods" }

function pod(): K8sObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "web",
      namespace: "prod",
      uid: "u1",
      resourceVersion: "100",
      managedFields: [
        { manager: "kubelet", operation: "Update", apiVersion: "v1", subresource: "status" },
      ],
    },
    spec: { containers: [{ name: "app", image: "nginx" }] },
    status: { phase: "Running" },
  }
}

async function mountTab(object: K8sObject) {
  const wrapper = mount(YamlTab, { props: { object, resourceRef: podRef } })
  await flushPromises() // resolve the async editor
  return wrapper
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll("button").find((b) => b.text() === label)
  if (found === undefined) throw new Error(`no "${label}" button`)
  return found
}

function isDisabled(wrapper: VueWrapper, label: string): boolean {
  return (button(wrapper, label).element as HTMLButtonElement).disabled
}

function allDisabled(wrapper: VueWrapper): boolean[] {
  return ["Cancel", "Dry run", "Apply"].map((label) => isDisabled(wrapper, label))
}

function editorText(wrapper: VueWrapper): string {
  return (wrapper.get("textarea").element as HTMLTextAreaElement).value
}

async function type(wrapper: VueWrapper, text: string): Promise<void> {
  await wrapper.get("textarea").setValue(text)
}

/** Toggle the "Full object (read-only)" checkbox; the second editor instance
 *  resolves through a microtask of its own. */
async function setFullView(wrapper: VueWrapper, on: boolean): Promise<void> {
  await wrapper.get("input[type=checkbox]").setValue(on)
  await flushPromises()
}

describe("YamlTab", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedApply.mockReset()
    mockedApply.mockResolvedValue({})
  })

  it("edits the apply-ready document and keeps the full object behind the toggle", async () => {
    const wrapper = await mountTab(pod())

    // What is edited is what Apply sends: no status, no server-managed metadata.
    expect(editorText(wrapper)).toContain("name: web")
    expect(editorText(wrapper)).not.toContain("managedFields")
    expect(editorText(wrapper)).not.toContain("resourceVersion")
    expect(editorText(wrapper)).not.toContain("phase: Running")
    expect(wrapper.get("textarea").attributes("readonly")).toBeUndefined()

    await setFullView(wrapper, true)
    expect(editorText(wrapper)).toContain("managedFields")
    expect(editorText(wrapper)).toContain("kubelet")
    expect(editorText(wrapper)).toContain("phase: Running")
    expect(wrapper.get("textarea").attributes("readonly")).toBeDefined()
  })

  // Both views are built from a clone: the detail page keeps handing the same
  // object to every other tab and to its actions.
  it("does not mutate the object it renders", async () => {
    const object = pod()
    const wrapper = await mountTab(object)
    await setFullView(wrapper, true)

    expect(object.metadata?.managedFields).toHaveLength(1)
    expect(object.status).toEqual({ phase: "Running" })
  })

  it("reseeds a clean draft silently when the page hands over a refreshed object", async () => {
    const wrapper = await mountTab(pod())
    const next = pod()
    next.metadata!.name = "web-2"

    await wrapper.setProps({ object: next })

    expect(editorText(wrapper)).toContain("name: web-2")
    expect(wrapper.text()).not.toContain("changed on the server")
    expect(allDisabled(wrapper)).toEqual([true, true, true])
  })

  it("gates all three actions on the draft being dirty", async () => {
    const wrapper = await mountTab(pod())
    expect(allDisabled(wrapper)).toEqual([true, true, true])

    await type(wrapper, "edited: yes\n")
    expect(allDisabled(wrapper)).toEqual([false, false, false])
  })

  it("restores the original text on Cancel", async () => {
    const wrapper = await mountTab(pod())
    const original = editorText(wrapper)

    await type(wrapper, "edited: yes\n")
    await button(wrapper, "Cancel").trigger("click")

    expect(editorText(wrapper)).toBe(original)
    expect(allDisabled(wrapper)).toEqual([true, true, true])
  })

  it("applies the edited text to the object the tab was opened on", async () => {
    const wrapper = await mountTab(pod())
    await type(wrapper, "edited: yes\n")

    await button(wrapper, "Apply").trigger("click")
    await flushPromises()

    expect(mockedApply).toHaveBeenCalledWith(podRef, "prod", "web", "edited: yes\n", {
      dryRun: false,
    })
    expect(useToastStore().toasts.map((t) => t.kind)).toEqual(["success"])
    expect(wrapper.emitted("applied")).toHaveLength(1)
    // The draft is now the baseline: nothing left to cancel or re-apply.
    expect(allDisabled(wrapper)).toEqual([true, true, true])
  })

  it("dry-runs without reporting a change and leaves the draft dirty", async () => {
    const wrapper = await mountTab(pod())
    await type(wrapper, "edited: yes\n")

    await button(wrapper, "Dry run").trigger("click")
    await flushPromises()

    expect(mockedApply).toHaveBeenCalledWith(podRef, "prod", "web", "edited: yes\n", {
      dryRun: true,
    })
    expect(wrapper.emitted("applied")).toBeUndefined()
    expect(editorText(wrapper)).toBe("edited: yes\n")
    expect(allDisabled(wrapper)).toEqual([false, false, false])
  })

  it("shows the native 409 conflict with every cause it carries", async () => {
    mockedApply.mockRejectedValue(
      new ApiError(409, "Apply failed with 2 conflicts", {
        details: {
          causes: [
            { message: 'conflict with "kubectl": .spec.containers' },
            { field: ".metadata.labels.app" },
          ],
        },
      }),
    )
    const wrapper = await mountTab(pod())
    await type(wrapper, "edited: yes\n")

    await button(wrapper, "Apply").trigger("click")
    await flushPromises()

    const conflict = wrapper.get("pre")
    expect(conflict.text()).toContain("Apply failed with 2 conflicts")
    expect(conflict.text()).toContain('conflict with "kubectl": .spec.containers')
    expect(conflict.text()).toContain(".metadata.labels.app")
    expect(wrapper.emitted("applied")).toBeUndefined()
  })

  it("shows any other failure in place", async () => {
    mockedApply.mockRejectedValue(new ApiError(403, 'pods "web" is forbidden'))
    const wrapper = await mountTab(pod())
    await type(wrapper, "edited: yes\n")

    await button(wrapper, "Apply").trigger("click")
    await flushPromises()

    expect(wrapper.text()).toContain('pods "web" is forbidden')
    expect(wrapper.find("pre").exists()).toBe(false) // not a conflict block
    expect(wrapper.emitted("applied")).toBeUndefined()
  })

  it("drops a rejected verdict as soon as editing continues", async () => {
    mockedApply.mockRejectedValue(new ApiError(400, "error validating data: unknown field"))
    const wrapper = await mountTab(pod())
    await type(wrapper, "edited: yes\n")

    await button(wrapper, "Dry run").trigger("click")
    await flushPromises()
    expect(wrapper.text()).toContain("unknown field")

    // The banner judged the text that was sent, not the one now on screen.
    await type(wrapper, "edited: no\n")
    expect(wrapper.text()).not.toContain("unknown field")
  })

  it("drops a conflict block as soon as editing continues", async () => {
    mockedApply.mockRejectedValue(
      new ApiError(409, "Apply failed with 1 conflict", {
        details: { causes: [{ field: ".spec.replicas" }] },
      }),
    )
    const wrapper = await mountTab(pod())
    await type(wrapper, "edited: yes\n")

    await button(wrapper, "Apply").trigger("click")
    await flushPromises()
    expect(wrapper.find("pre").exists()).toBe(true)

    await type(wrapper, "edited: no\n")
    expect(wrapper.find("pre").exists()).toBe(false)
  })

  // Regression shape: a Refresh (or an update from elsewhere) must not throw
  // away what the user typed.
  it("keeps a dirty draft across a refresh and says the object moved", async () => {
    const wrapper = await mountTab(pod())
    await type(wrapper, "edited: yes\n")

    const next = pod()
    next.metadata!.labels = { app: "web" }
    await wrapper.setProps({ object: next })

    expect(editorText(wrapper)).toBe("edited: yes\n")
    expect(wrapper.text()).toContain("changed on the server")

    // Cancel reloads the *new* version, not the one the tab opened on.
    await button(wrapper, "Cancel").trigger("click")
    expect(editorText(wrapper)).toContain("app: web")
    expect(wrapper.text()).not.toContain("changed on the server")
  })

  // Staleness is measured on the editable projection: useResourceObject hands
  // over a new object on every refresh, and a status heartbeat moves
  // resourceVersion without touching a byte of what this tab edits.
  it("does not cry stale over server-managed fields alone", async () => {
    const wrapper = await mountTab(pod())
    await type(wrapper, "edited: yes\n")

    const next = pod()
    next.metadata!.resourceVersion = "101"
    next.metadata!.managedFields = [{ manager: "kube-console", operation: "Apply" }]
    next.status = { phase: "Succeeded" }
    await wrapper.setProps({ object: next })

    expect(editorText(wrapper)).toBe("edited: yes\n")
    expect(wrapper.text()).not.toContain("changed on the server")
  })

  it("survives a round trip through the full view", async () => {
    const wrapper = await mountTab(pod())
    await type(wrapper, "edited: yes\n")

    await setFullView(wrapper, true)
    expect(editorText(wrapper)).toContain("managedFields")
    // The draft is not on screen, so neither Apply nor Cancel may act on it.
    expect(allDisabled(wrapper)).toEqual([true, true, true])

    await setFullView(wrapper, false)
    expect(editorText(wrapper)).toBe("edited: yes\n")
    expect(allDisabled(wrapper)).toEqual([false, false, false])
  })

  describe("Secret decode mode", () => {
    const secretRef: ResourceRef = { group: "", version: "v1", resource: "secrets" }
    const BINARY = "//4AAQLI" // not UTF-8

    function secret(password = "s3cret"): K8sObject {
      return {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "db", namespace: "prod", uid: "s1", resourceVersion: "7" },
        data: { bin: BINARY, password: encodeBase64Utf8(password) },
        type: "Opaque",
      }
    }

    async function mountSecret(object: K8sObject = secret()) {
      const wrapper = mount(YamlTab, { props: { object, resourceRef: secretRef } })
      await flushPromises()
      return wrapper
    }

    function decodeBox(wrapper: VueWrapper) {
      const label = wrapper.findAll("label").find((l) => l.text() === "Decode base64")
      if (label === undefined) throw new Error("no decode toggle")
      return label.get("input")
    }

    async function setDecoded(wrapper: VueWrapper, on: boolean): Promise<void> {
      await decodeBox(wrapper).setValue(on)
      await flushPromises()
    }

    /** The data map a mocked apply call was sent. */
    function sentData(call = 0): unknown {
      return (parse(mockedApply.mock.calls[call]![3]) as K8sObject).data
    }

    it("is offered for Secrets only", async () => {
      const podTab = await mountTab(pod())
      expect(podTab.text()).not.toContain("Decode base64")
      const secretTab = await mountSecret()
      expect(secretTab.text()).toContain("Decode base64")
    })

    it("starts encoded and shows text plain and binary as !!binary once switched on", async () => {
      const wrapper = await mountSecret()
      expect(editorText(wrapper)).toContain(`password: ${encodeBase64Utf8("s3cret")}`)

      await setDecoded(wrapper, true)
      expect(editorText(wrapper)).toContain("password: s3cret")
      expect(editorText(wrapper)).toMatch(/bin: !!binary/)
      // A projection switch is not an edit.
      expect(allDisabled(wrapper)).toEqual([true, true, true])

      await setDecoded(wrapper, false)
      expect(editorText(wrapper)).toContain(`password: ${encodeBase64Utf8("s3cret")}`)
    })

    it.each([
      ["Apply", false],
      ["Dry run", true],
    ])("%s sends the edit re-encoded, binary values untouched", async (label, dryRun) => {
      const wrapper = await mountSecret()
      await setDecoded(wrapper, true)
      await type(wrapper, editorText(wrapper).replace("password: s3cret", "password: n3w ✓"))

      await button(wrapper, label).trigger("click")
      await flushPromises()

      expect(mockedApply).toHaveBeenCalledTimes(1)
      expect(mockedApply.mock.calls[0]![4]).toEqual({ dryRun })
      expect(sentData()).toEqual({ bin: BINARY, password: encodeBase64Utf8("n3w ✓") })
    })

    it("refuses a non-string value without sending anything", async () => {
      const wrapper = await mountSecret()
      await setDecoded(wrapper, true)
      await type(wrapper, editorText(wrapper).replace("password: s3cret", "password: 12345"))

      await button(wrapper, "Apply").trigger("click")
      await flushPromises()

      expect(mockedApply).not.toHaveBeenCalled()
      expect(wrapper.text()).toContain("data.password must be a string")
      expect(wrapper.emitted("applied")).toBeUndefined()
    })

    it("cannot switch under a dirty draft", async () => {
      const wrapper = await mountSecret()
      await setDecoded(wrapper, true)
      await type(wrapper, editorText(wrapper).replace("s3cret", "edited"))

      expect((decodeBox(wrapper).element as HTMLInputElement).disabled).toBe(true)
    })

    it("Cancel returns to the decoded text", async () => {
      const wrapper = await mountSecret()
      await setDecoded(wrapper, true)
      const decodedText = editorText(wrapper)
      await type(wrapper, decodedText.replace("s3cret", "edited"))

      await button(wrapper, "Cancel").trigger("click")
      expect(editorText(wrapper)).toBe(decodedText)
    })

    it("reseeds silently after Apply, still decoded", async () => {
      const wrapper = await mountSecret()
      await setDecoded(wrapper, true)
      await type(wrapper, editorText(wrapper).replace("password: s3cret", "password: n3w"))
      await button(wrapper, "Apply").trigger("click")
      await flushPromises()

      await wrapper.setProps({ object: secret("n3w") })

      expect(editorText(wrapper)).toContain("password: n3w")
      expect(wrapper.text()).not.toContain("changed on the server")
      expect(allDisabled(wrapper)).toEqual([true, true, true])
    })

    it("keeps a dirty decoded draft across a refresh, still in decoded mode", async () => {
      const wrapper = await mountSecret()
      await setDecoded(wrapper, true)
      const edited = editorText(wrapper).replace("password: s3cret", "password: mine")
      await type(wrapper, edited)

      await wrapper.setProps({ object: secret("theirs") })
      expect(editorText(wrapper)).toBe(edited)
      expect(wrapper.text()).toContain("changed on the server")

      // Cancel reloads the new version in the same projection.
      await button(wrapper, "Cancel").trigger("click")
      expect(editorText(wrapper)).toContain("password: theirs")
    })
  })
})
