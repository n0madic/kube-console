import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it } from "vitest"
import { nextTick } from "vue"

import ThemeToggle from "@/components/layout/ThemeToggle.vue"
import { usePreferencesStore } from "@/stores/preferences"
import { useUiStore } from "@/stores/ui"

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

  // A narrow header has no room for three segments, so the same three modes
  // become one button that steps through them.
  describe("on a narrow viewport", () => {
    async function mountNarrow() {
      const ui = useUiStore()
      ui.narrowViewport = true
      await nextTick()
      return mount(ThemeToggle)
    }

    it("collapses to a single button", async () => {
      const wrapper = await mountNarrow()
      expect(wrapper.findAll("button")).toHaveLength(1)
      expect(wrapper.find("[role='radiogroup']").exists()).toBe(false)
    })

    it("cycles through the modes and names both the current one and the next", async () => {
      const prefs = usePreferencesStore()
      const wrapper = await mountNarrow()
      const button = wrapper.get("button")

      expect(prefs.prefs.theme).toBe("system")
      expect(button.attributes("aria-label")).toBe(
        "Theme: Auto (match system theme). Switch to Light theme",
      )

      await button.trigger("click")
      expect(prefs.prefs.theme).toBe("light")
      expect(button.attributes("aria-label")).toBe("Theme: Light theme. Switch to Dark theme")

      await button.trigger("click")
      expect(prefs.prefs.theme).toBe("dark")

      // ...and back round to Auto, so every mode stays reachable.
      await button.trigger("click")
      expect(prefs.prefs.theme).toBe("system")
    })
  })
})
