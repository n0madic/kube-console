import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/api/k8s", () => ({ patchObject: vi.fn(), createObject: vi.fn() }))

import { ApiError } from "@/api/http"
import { createObject, patchObject } from "@/api/k8s"
import type { K8sObject, ResourceRef } from "@/api/types"
import ResourceActions from "@/components/detail/ResourceActions.vue"

const mockedPatch = vi.mocked(patchObject)
const mockedCreate = vi.mocked(createObject)

// The real dialog teleports through reka-ui; a passthrough keeps the assertions
// on this component's own behavior.
const dialogStub = {
  props: { open: Boolean, title: String },
  template: `<div v-if="open" class="dialog"><slot /><slot name="footer" /></div>`,
}

const deploymentRef: ResourceRef = { group: "apps", version: "v1", resource: "deployments" }
const deployment: K8sObject = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "default", uid: "d1" },
  spec: { replicas: 2 },
}

const cronJobRef: ResourceRef = { group: "batch", version: "v1", resource: "cronjobs" }
const cronJob: K8sObject = {
  apiVersion: "batch/v1",
  kind: "CronJob",
  metadata: { name: "backup", namespace: "ops", uid: "c1" },
  spec: { jobTemplate: { spec: { backoffLimit: 1 } } },
}

function mountFor(object: K8sObject, resourceRef: ResourceRef) {
  return mount(ResourceActions, {
    props: { object, resourceRef },
    global: { stubs: { BaseDialog: dialogStub } },
  })
}

async function open(wrapper: VueWrapper, label: string): Promise<void> {
  const button = wrapper.findAll("button").find((b) => b.text() === label)
  if (button === undefined) throw new Error(`no "${label}" button`)
  await button.trigger("click")
}

/** The dialog's confirm button (the last one in its footer). */
async function confirm(wrapper: VueWrapper): Promise<void> {
  const buttons = wrapper.findAll(".dialog button")
  const last = buttons[buttons.length - 1]
  if (last === undefined) throw new Error("dialog is not open")
  await last.trigger("click")
  await flushPromises()
}

describe("ResourceActions", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedPatch.mockReset()
    mockedCreate.mockReset()
    mockedPatch.mockResolvedValue({})
    mockedCreate.mockResolvedValue({})
  })

  it("renders the kind's actions and nothing for kinds without any", () => {
    const wrapper = mountFor(deployment, deploymentRef)
    expect(wrapper.findAll("button").map((b) => b.text())).toEqual(["Scale", "Restart"])

    const plain = mountFor({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cm" } }, {
      group: "",
      version: "v1",
      resource: "configmaps",
    })
    expect(plain.findAll("button")).toHaveLength(0)
  })

  it("restarts through a strategic merge patch carrying the kubectl annotation", async () => {
    const wrapper = mountFor(deployment, deploymentRef)
    await open(wrapper, "Restart")

    // The target is spelled out, not buried in the sentence: the name carries
    // the emphasis, the namespace only qualifies it.
    expect(wrapper.findAll(".dialog strong").map((s) => s.text())).toEqual(["web"])
    expect(wrapper.get(".dialog").text()).toContain("Deployment")
    expect(wrapper.get(".dialog").text()).toContain("in default namespace")

    await confirm(wrapper)

    expect(mockedPatch).toHaveBeenCalledWith(
      deploymentRef,
      "default",
      "web",
      {
        spec: {
          template: {
            metadata: {
              annotations: { "kubectl.kubernetes.io/restartedAt": expect.any(String) },
            },
          },
        },
      },
      { type: "strategic" },
    )
    expect(wrapper.emitted("changed")).toHaveLength(1)
    expect(wrapper.find(".dialog").exists()).toBe(false)
  })

  it("scales through the scale subresource, pre-filled with the current count", async () => {
    const wrapper = mountFor(deployment, deploymentRef)
    await open(wrapper, "Scale")
    const input = wrapper.find(".dialog input")
    expect((input.element as HTMLInputElement).value).toBe("2")

    await input.setValue("3")
    await confirm(wrapper)

    expect(mockedPatch).toHaveBeenCalledWith(
      deploymentRef,
      "default",
      "web",
      { spec: { replicas: 3 } },
      { subresource: "scale" },
    )
    expect(wrapper.emitted("changed")).toHaveLength(1)
  })

  it("steps the replica count and never below zero", async () => {
    const wrapper = mountFor({ ...deployment, spec: { replicas: 0 } }, deploymentRef)
    await open(wrapper, "Scale")

    const decrease = wrapper.get('[aria-label="Decrease replicas"]')
    expect((decrease.element as HTMLButtonElement).disabled).toBe(true)

    await wrapper.get('[aria-label="Increase replicas"]').trigger("click")
    expect((wrapper.get(".dialog input").element as HTMLInputElement).value).toBe("1")
    await confirm(wrapper)

    expect(mockedPatch).toHaveBeenCalledWith(
      deploymentRef,
      "default",
      "web",
      { spec: { replicas: 1 } },
      { subresource: "scale" },
    )
  })

  it("suspends a cronjob through a merge patch", async () => {
    const wrapper = mountFor(cronJob, cronJobRef)
    await open(wrapper, "Suspend")
    await confirm(wrapper)
    expect(mockedPatch).toHaveBeenCalledWith(cronJobRef, "ops", "backup", {
      spec: { suspend: true },
    })
  })

  it("triggers a cronjob by creating a Job in the jobs collection", async () => {
    const wrapper = mountFor(cronJob, cronJobRef)
    await open(wrapper, "Trigger now")
    const jobName = (wrapper.find(".dialog input").element as HTMLInputElement).value
    expect(jobName).toMatch(/^backup-manual-\d+$/)

    await confirm(wrapper)

    expect(mockedCreate).toHaveBeenCalledWith(
      { group: "batch", version: "v1", resource: "jobs" },
      "ops",
      {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: jobName,
          annotations: { "cronjob.kubernetes.io/instantiate": "manual" },
          ownerReferences: [
            { apiVersion: "batch/v1", kind: "CronJob", name: "backup", uid: "c1" },
          ],
        },
        spec: { backoffLimit: 1 },
      },
    )
    expect(wrapper.emitted("changed")).toHaveLength(1)
  })

  it("keeps the dialog open and shows the API error, without reporting a change", async () => {
    mockedPatch.mockRejectedValue(new ApiError(403, "deployments.apps \"web\" is forbidden"))
    const wrapper = mountFor(deployment, deploymentRef)
    await open(wrapper, "Restart")
    await confirm(wrapper)

    expect(wrapper.find(".dialog").exists()).toBe(true)
    expect(wrapper.text()).toContain("is forbidden")
    expect(wrapper.emitted("changed")).toBeUndefined()
  })
})
