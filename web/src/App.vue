<script setup lang="ts">
import { watchEffect } from "vue"
import { useRoute } from "vue-router"

import AppShell from "@/components/layout/AppShell.vue"
import { useDarkMode } from "@/composables/useDarkMode"
import { useLocalIdentity } from "@/composables/useLocalIdentity"
import { usePageTitle } from "@/composables/usePageTitle"

const route = useRoute()

// Tab title follows the active cluster (see composables/usePageTitle.ts).
usePageTitle()
// Local kubeconfig mode only (the query is disabled otherwise): resolve who the
// backend's credentials are, so TopBar names them like any signed-in user.
useLocalIdentity()

// Theme: toggle the .dark class on <html> (see @custom-variant in style.css).
// useDarkMode owns the "explicit preference, else the OS" rule and the media
// listener that keeps "system" live — the same signal CodeMirrorEditor reads.
const isDark = useDarkMode()
watchEffect(() => {
  document.documentElement.classList.toggle("dark", isDark.value)
})
</script>

<template>
  <RouterView v-if="route.meta.public === true" />
  <AppShell v-else />
</template>
