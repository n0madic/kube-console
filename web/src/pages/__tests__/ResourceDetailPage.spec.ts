import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

import type { K8sObject } from "@/api/types"

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
