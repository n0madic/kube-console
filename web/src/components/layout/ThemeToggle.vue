<script setup lang="ts">
// Segmented theme switch: Auto (follow OS) / Light / Dark. Writes prefs.theme;
// App.vue applies the .dark class and keeps Auto live with the OS.

import AppIcon from "@/components/ui/AppIcon.vue"
import { usePreferencesStore } from "@/stores/preferences"
import type { IconName } from "@/utils/icons"

type Theme = "system" | "light" | "dark"

const prefs = usePreferencesStore()

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
</script>

<template>
  <div
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
