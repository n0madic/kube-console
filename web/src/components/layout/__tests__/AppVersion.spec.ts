import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import { ref } from "vue"

import type { ContextsResponse } from "@/api/types"

vi.mock("@/composables/useContexts", () => ({ useContextsQuery: vi.fn() }))

import AppVersion from "@/components/layout/AppVersion.vue"
import { useContextsQuery } from "@/composables/useContexts"

const mockedQuery = vi.mocked(useContextsQuery)

function mountVersion(data: Partial<ContextsResponse> | undefined) {
  mockedQuery.mockReturnValue({
    data: ref(data === undefined ? undefined : { contexts: [], default: "", ...data }),
  } as unknown as ReturnType<typeof useContextsQuery>)
  return mount(AppVersion)
}

describe("AppVersion", () => {
  it("shows a release tag", () => {
    const wrapper = mountVersion({ version: "v0.1.1" })

    expect(wrapper.text()).toContain("v0.1.1")
    // Truncated in a 16rem sidebar, so the whole string stays reachable.
    expect(wrapper.get("[title]").attributes("title")).toBe("v0.1.1")
  })

  // A build off a branch is identified by its commit, not by the last tag that
  // happens to be reachable from it.
  it("shows a short commit", () => {
    expect(mountVersion({ version: "f72a678" }).text()).toContain("f72a678")
  })

  // "Unknown build" is worse than no line: before the query answers, and from a
  // backend too old to send the field, the footer is simply absent.
  it("renders nothing without a version", () => {
    expect(mountVersion({}).text()).toBe("")
    expect(mountVersion({ version: "   " }).text()).toBe("")
    expect(mountVersion(undefined).text()).toBe("")
  })
})
