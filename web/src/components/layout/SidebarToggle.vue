<script setup lang="ts">
// The one sidebar toggle, mounted in two places: the sidebar's own header while
// it is open, the TopBar while it is hidden — so the control sits at the edge
// of what it controls instead of leaving a stray button behind an open sidebar.
//
// Because the control moves, activating it removes the very element that has
// the focus. The store marks a handoff (`consumeToggleFocus`) and the instance
// mounting in its place claims it here — a keyboard user would otherwise land
// back on `<body>`. Deliberately not a `document.querySelector` for the other
// button: that would depend on an invariant ("exactly one is mounted") spelled
// out in two other files, and could focus a `display:none` one.

import { onMounted, ref } from "vue"

import AppIcon from "@/components/ui/AppIcon.vue"
import { useUiStore } from "@/stores/ui"

const ui = useUiStore()

const el = ref<HTMLButtonElement | null>(null)

onMounted(() => {
  if (ui.consumeToggleFocus()) el.value?.focus()
})
</script>

<template>
  <!-- AppIcon is always aria-hidden, so the label lives on the button. -->
  <button
    ref="el"
    type="button"
    class="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    aria-controls="app-sidebar"
    :aria-expanded="ui.sidebarOpen"
    :aria-label="ui.sidebarOpen ? 'Hide sidebar' : 'Show sidebar'"
    :title="ui.sidebarOpen ? 'Hide sidebar' : 'Show sidebar'"
    @click="ui.toggleSidebar()"
  >
    <!-- Open, the button sits inside the panel it collapses, so it shows the
         panel glyph pointing at it; hidden, it is the TopBar's menu button and
         a hamburger is what that means. -->
    <AppIcon :name="ui.sidebarOpen ? 'sidebar-collapse' : 'bars-3'" class="h-5 w-5" />
  </button>
</template>
