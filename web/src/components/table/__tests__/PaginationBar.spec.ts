import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

import PaginationBar from "@/components/table/PaginationBar.vue"

describe("PaginationBar", () => {
  it("hides the Next page button when there is no continue token", () => {
    const wrapper = mount(PaginationBar, {
      props: { hasNextPage: false, paged: false, loading: false, rowCount: 3 },
    })
    expect(wrapper.text()).not.toContain("Next page")
  })

  it("shows the Next page button when a continue token is available", () => {
    const wrapper = mount(PaginationBar, {
      props: { hasNextPage: true, paged: false, loading: false, rowCount: 500 },
    })
    expect(wrapper.text()).toContain("Next page")
  })

  it("keeps Back to start visible once paged, even after the last page", () => {
    const wrapper = mount(PaginationBar, {
      props: { hasNextPage: false, paged: true, loading: false, rowCount: 10 },
    })
    expect(wrapper.text()).toContain("Back to start")
    expect(wrapper.text()).not.toContain("Next page")
  })
})
