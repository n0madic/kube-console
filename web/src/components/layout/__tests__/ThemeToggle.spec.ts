import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it } from "vitest"

import ThemeToggle from "@/components/layout/ThemeToggle.vue"
import { usePreferencesStore } from "@/stores/preferences"

describe("ThemeToggle", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
  })

  it("renders three theme options and marks the active one", () => {
    const prefs = usePreferencesStore()
    const wrapper = mount(ThemeToggle)
    const buttons = wrapper.findAll("button[role='radio']")
    expect(buttons).toHaveLength(3)
    // Default preference is "system" (Auto).
    expect(prefs.prefs.theme).toBe("system")
    const auto = wrapper.get("button[aria-label='Auto (match system theme)']")
    expect(auto.attributes("aria-checked")).toBe("true")
  })

  it("updates the preference when an option is clicked", async () => {
    const prefs = usePreferencesStore()
    const wrapper = mount(ThemeToggle)
    await wrapper.get("button[aria-label='Dark theme']").trigger("click")
    expect(prefs.prefs.theme).toBe("dark")
    await wrapper.get("button[aria-label='Light theme']").trigger("click")
    expect(prefs.prefs.theme).toBe("light")
    expect(wrapper.get("button[aria-label='Light theme']").attributes("aria-checked")).toBe("true")
    expect(wrapper.get("button[aria-label='Dark theme']").attributes("aria-checked")).toBe("false")
  })
})
