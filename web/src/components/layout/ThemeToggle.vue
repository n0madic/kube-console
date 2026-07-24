<script setup lang="ts">
// Segmented theme switch: Auto (follow OS) / Light / Dark. Writes prefs.theme;
// App.vue applies the .dark class and keeps Auto live with the OS.
//
// On a narrow viewport the three segments are the widest thing in the header,
// so the control collapses to a single button stepping through the same order
// (Auto → Light → Dark → Auto). It is a plain button there, not a one-option
// radiogroup: only the current mode is on screen, so the label has to say both
// what is set and what a click will do.

import { computed } from "vue"

import AppIcon from "@/components/ui/AppIcon.vue"
import { usePreferencesStore } from "@/stores/preferences"
import { useUiStore } from "@/stores/ui"
import type { IconName } from "@/utils/icons"

type Theme = "system" | "light" | "dark"

const prefs = usePreferencesStore()
const ui = useUiStore()

const ICON: Record<Theme, IconName> = {
  system: "computer-desktop",
  light: "sun",
  dark: "moon",
}

const options: Array<{ value: Theme; label: string }> = [
  { value: "system", label: "Auto (match system theme)" },
  { value: "light", label: "Light theme" },
  { value: "dark", label: "Dark theme" },
]

function labelOf(theme: Theme): string {
  return options.find((o) => o.value === theme)?.label ?? ""
}

// An unknown stored value cannot reach here (the prefs allowlist sanitizes it),
// but indexOf's -1 would still land on the first option rather than out of it.
const nextTheme = computed<Theme>(() => {
  const idx = options.findIndex((o) => o.value === prefs.prefs.theme)
  return options[(idx + 1) % options.length]!.value
})

const cycleLabel = computed(
  () => `Theme: ${labelOf(prefs.prefs.theme)}. Switch to ${labelOf(nextTheme.value)}`,
)
</script>

<template>
  <button
    v-if="ui.narrowViewport"
    type="button"
    class="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    :aria-label="cycleLabel"
    :title="cycleLabel"
    @click="prefs.prefs.theme = nextTheme"
  >
    <AppIcon :name="ICON[prefs.prefs.theme]" class="h-5 w-5" />
  </button>

  <div
    v-else
    role="radiogroup"
    aria-label="Theme"
    class="flex items-center gap-0.5 rounded-md border border-slate-200 p-0.5 dark:border-slate-700"
  >
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="radio"
      :aria-checked="prefs.prefs.theme === opt.value"
      :aria-label="opt.label"
      :title="opt.label"
      class="rounded p-1.5 transition-colors"
      :class="
        prefs.prefs.theme === opt.value
          ? 'bg-slate-100 text-slate-900 dark:bg-slate-700 dark:text-white'
          : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
      "
      @click="prefs.prefs.theme = opt.value"
    >
      <AppIcon :name="ICON[opt.value]" class="h-4 w-4" />
    </button>
  </div>
</template>
