import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref, shallowRef } from "vue"

import type { OwnedPods } from "@/api/ownedPods"
import type { K8sObject } from "@/api/types"
import type { OwnedPodsState } from "@/composables/useOwnedPods"

const POD: K8sObject = {
  kind: "Pod",
  metadata: { uid: "u1", name: "pod-a", namespace: "default" },
  spec: { containers: [{ name: "app" }] },
}

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
  RouterLink: { template: "<a><slot /></a>" },
}))
vi.mock("@/router", () => ({ resourceListRoute: () => "/r/core/v1/pods" }))

const object = ref<K8sObject | null>(POD)
const refresh = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/composables/useResourceObject", () => ({
  useResourceObject: () => ({
    object,
    loading: ref(false),
    error: ref(null),
    refresh,
  }),
}))

// Module-level like `object`: the real composable would walk the cluster.
// The key is the real one — the page provides under it.
const ownedState = shallowRef<OwnedPodsState>({ loading: false, error: null, result: null })
vi.mock("@/composables/useOwnedPods", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useOwnedPods")>()
  return {
    ...actual,
    useOwnedPods: () => ({ state: ownedState }),
  }
})

import BaseTabs from "@/components/ui/BaseTabs.vue"
import ResourceDetailPage from "@/pages/ResourceDetailPage.vue"

function mountPage() {
  return mount(ResourceDetailPage, {
    props: {
      group: "core",
      version: "v1",
      resource: "pods",
      namespace: "default",
      name: "pod-a",
    },
    shallow: true,
    global: { stubs: { RouterLink: true } },
  })
}

async function selectTab(wrapper: ReturnType<typeof mountPage>, tab: string) {
  wrapper.getComponent(BaseTabs).vm.$emit("update:modelValue", tab)
  await wrapper.vm.$nextTick()
}

describe("ResourceDetailPage", () => {
  // The object ref is module-level (the composable is mocked), so reset it here
  // rather than at the end of a test body — a failing assertion would skip that.
  // The refresh spy is module-level for the same reason, and mounting already
  // calls it through onMounted.
  beforeEach(() => {
    object.value = POD
    ownedState.value = { loading: false, error: null, result: null }
    refresh.mockClear()
  })

  // Regression: the terminal was part of the v-if tab chain, so switching to
  // any other tab unmounted it — killing the exec session (and, with it, the
  // shell running in the pod) and dumping the user back on the connect form.
  it("keeps the pod terminal mounted while another tab is shown", async () => {
    const wrapper = mountPage()
    const terminal = () => wrapper.findComponent({ name: "PodTerminalTab" })

    expect(terminal().exists()).toBe(false) // not mounted until first opened

    await selectTab(wrapper, "terminal")
    expect(terminal().exists()).toBe(true)
    expect(terminal().props("active")).toBe(true)

    await selectTab(wrapper, "logs")
    expect(terminal().exists()).toBe(true) // hidden, not unmounted
    expect(terminal().props("active")).toBe(false)
    expect(terminal().attributes("style")).toContain("display: none")

    await selectTab(wrapper, "terminal")
    expect(terminal().props("active")).toBe(true)
    expect(terminal().attributes("style") ?? "").not.toContain("display: none")
  })

  // Same shape as the terminal, for the same kind of reason: the YAML tab holds
  // an editable draft, and the v-if chain would throw it away on a tab switch.
  it("keeps the YAML tab mounted while another tab is shown", async () => {
    const wrapper = mountPage()
    const yaml = () => wrapper.findComponent({ name: "YamlTab" })

    expect(yaml().exists()).toBe(false) // not mounted until first opened

    await selectTab(wrapper, "yaml")
    expect(yaml().exists()).toBe(true)

    await selectTab(wrapper, "overview")
    expect(yaml().exists()).toBe(true) // hidden, not unmounted
    expect(yaml().attributes("style")).toContain("display: none")

    await selectTab(wrapper, "yaml")
    expect(yaml().attributes("style") ?? "").not.toContain("display: none")
  })

  it("hands the YAML tab the resource ref and refreshes on apply", async () => {
    const wrapper = mountPage()
    await selectTab(wrapper, "yaml")
    const yaml = wrapper.getComponent({ name: "YamlTab" })

    expect(yaml.props("resourceRef")).toEqual({ group: "", version: "v1", resource: "pods" })

    yaml.vm.$emit("applied")
    await wrapper.vm.$nextTick()
    expect(refresh).toHaveBeenCalled()
  })

  it("does not mount a terminal for non-pod kinds", async () => {
    object.value = { kind: "Node", metadata: { uid: "n1", name: "node-a" } }
    const wrapper = mountPage()
    await selectTab(wrapper, "metrics")
    expect(wrapper.findComponent({ name: "PodTerminalTab" }).exists()).toBe(false)
  })
})

const DEPLOYMENT: K8sObject = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { uid: "d1", name: "web", namespace: "default" },
}

function owned(...names: string[]): OwnedPods {
  return {
    pods: {
      kind: "Table",
      columnDefinitions: [{ name: "Name", type: "string" }],
      rows: names.map((name) => ({ cells: [name], object: { metadata: { name, uid: `u-${name}` } } })),
    },
    truncated: false,
  }
}

function tabIds(wrapper: ReturnType<typeof mountPage>): string[] {
  return (wrapper.getComponent(BaseTabs).props("tabs") as Array<{ id: string }>).map((t) => t.id)
}

describe("ResourceDetailPage workload Logs tab", () => {
  beforeEach(() => {
    object.value = DEPLOYMENT
    ownedState.value = { loading: false, error: null, result: owned("web-1", "web-2") }
    refresh.mockClear()
  })

  it("offers a Logs tab backed by WorkloadLogsTab when the workload owns pods", async () => {
    const wrapper = mountPage()
    expect(tabIds(wrapper)).toEqual(["overview", "yaml", "logs"])

    await selectTab(wrapper, "logs")
    const tab = wrapper.getComponent({ name: "WorkloadLogsTab" })
    expect(tab.props("object")).toEqual(DEPLOYMENT)
    expect(tab.props("ownedPods")).toEqual(ownedState.value.result)
    expect(wrapper.findComponent({ name: "PodLogsTab" }).exists()).toBe(false)
  })

  it("offers no Logs tab without pods, nor while nothing is resolved", async () => {
    ownedState.value = { loading: false, error: null, result: owned() }
    expect(tabIds(mountPage())).toEqual(["overview", "yaml"])

    ownedState.value = { loading: true, error: null, result: null }
    expect(tabIds(mountPage())).toEqual(["overview", "yaml"])
  })

  it("keeps the Pod kind on PodLogsTab", async () => {
    object.value = POD
    ownedState.value = { loading: false, error: null, result: null }
    const wrapper = mountPage()
    await selectTab(wrapper, "logs")
    expect(wrapper.findComponent({ name: "PodLogsTab" }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: "WorkloadLogsTab" }).exists()).toBe(false)
  })

  // The composable keeps the previous result across a same-object refresh;
  // this is why. A blank result mid-refresh would remove the tab and the tab
  // watch would bounce the user to Overview on every Refresh click.
  it("stays on Logs across a refresh that keeps the result", async () => {
    const wrapper = mountPage()
    await selectTab(wrapper, "logs")

    const kept = ownedState.value.result
    ownedState.value = { loading: true, error: null, result: kept }
    object.value = { ...DEPLOYMENT }
    await wrapper.vm.$nextTick()
    expect(wrapper.getComponent(BaseTabs).props("modelValue")).toBe("logs")
    expect(wrapper.findComponent({ name: "WorkloadLogsTab" }).exists()).toBe(true)

    ownedState.value = { loading: false, error: null, result: owned("web-3") }
    await wrapper.vm.$nextTick()
    expect(wrapper.getComponent(BaseTabs).props("modelValue")).toBe("logs")
  })

  it("falls back to Overview when the pods go away", async () => {
    const wrapper = mountPage()
    await selectTab(wrapper, "logs")

    ownedState.value = { loading: false, error: null, result: null }
    await wrapper.vm.$nextTick()
    expect(wrapper.getComponent(BaseTabs).props("modelValue")).toBe("overview")
    expect(wrapper.findComponent({ name: "WorkloadLogsTab" }).exists()).toBe(false)
  })
})
