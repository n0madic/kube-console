<script setup lang="ts">
import { onBeforeUnmount, watchEffect } from "vue"
import { useRoute } from "vue-router"

import AppShell from "@/components/layout/AppShell.vue"
import { usePageTitle } from "@/composables/usePageTitle"
import { usePreferencesStore } from "@/stores/preferences"

const route = useRoute()
const prefs = usePreferencesStore()

// Tab title follows the active cluster (see composables/usePageTitle.ts).
usePageTitle()

// Theme: toggle the .dark class on <html> (see @custom-variant in style.css).
const media = window.matchMedia("(prefers-color-scheme: dark)")

function applyTheme(): void {
  const theme = prefs.prefs.theme
  const dark = theme === "dark" || (theme === "system" && media.matches)
  document.documentElement.classList.toggle("dark", dark)
}

// watchEffect reruns on prefs.theme changes; the media listener keeps "system"
// live when the OS theme flips (matchMedia.matches is not reactive on its own).
watchEffect(applyTheme)
media.addEventListener("change", applyTheme)
onBeforeUnmount(() => media.removeEventListener("change", applyTheme))
</script>

<template>
  <RouterView v-if="route.meta.public === true" />
  <AppShell v-else />
</template>
