import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import { ref } from "vue"

import type { ContextsResponse } from "@/api/types"

vi.mock("@/composables/useContexts", () => ({ useContextsQuery: vi.fn() }))

import ClusterName from "@/components/layout/ClusterName.vue"
import { useContextsQuery } from "@/composables/useContexts"

const mockedQuery = vi.mocked(useContextsQuery)

function mountName(data: Partial<ContextsResponse> | undefined, inline = false) {
  mockedQuery.mockReturnValue({
    data: ref(data === undefined ? undefined : { contexts: [], default: "", ...data }),
  } as unknown as ReturnType<typeof useContextsQuery>)
  return mount(ClusterName, { props: { inline } })
}

describe("ClusterName", () => {
  it("shows the configured cluster name", () => {
    const wrapper = mountName({ clusterName: "prod-eu" })

    expect(wrapper.text()).toContain("prod-eu")
    // Long names truncate in a 16rem sidebar, so the full value stays reachable.
    expect(wrapper.get("[title]").attributes("title")).toBe("prod-eu")
  })

  // Same label, two homes: a bordered band in the sidebar, an item of the
  // TopBar row while the sidebar is hidden.
  it("drops the sidebar row's band when inline", () => {
    const sidebar = mountName({ clusterName: "prod-eu" })
    expect(sidebar.get("div").classes()).toContain("border-b")

    const inline = mountName({ clusterName: "prod-eu" }, true)
    expect(inline.get("div").classes()).not.toContain("border-b")
    expect(inline.text()).toContain("prod-eu")
  })

  // Nothing configured is the default deployment: the row would then be a
  // label with no value, and the switcher below already names the context.
  it("renders nothing without a configured name", () => {
    expect(mountName({}).text()).toBe("")
    expect(mountName({ clusterName: "   " }).text()).toBe("")
    // …including before the contexts query has answered.
    expect(mountName(undefined).text()).toBe("")
  })
})
