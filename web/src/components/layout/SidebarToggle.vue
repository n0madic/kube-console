<script setup lang="ts">
// The one sidebar toggle, mounted in two places: the sidebar's own header while
// it is open, the TopBar while it is hidden — so the control sits at the edge
// of what it controls instead of leaving a stray button behind an open sidebar.
//
// Both call sites are v-if'd, so exactly one instance exists at a time. That is
// what lets the handler hand focus to the instance taking over: the button
// being activated is precisely the one that goes away, and without the handoff
// a keyboard user would be dropped back to the top of the document.

import { nextTick } from "vue"

import AppIcon from "@/components/ui/AppIcon.vue"
import { useUiStore } from "@/stores/ui"

const ui = useUiStore()

async function toggle(): Promise<void> {
  ui.toggleSidebar()
  await nextTick()
  document.querySelector<HTMLElement>("[data-sidebar-toggle]")?.focus()
}
</script>

<template>
  <!-- AppIcon is always aria-hidden, so the label lives on the button. -->
  <button
    type="button"
    data-sidebar-toggle
    class="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    aria-controls="app-sidebar"
    :aria-expanded="ui.sidebarOpen"
    :aria-label="ui.sidebarOpen ? 'Hide sidebar' : 'Show sidebar'"
    :title="ui.sidebarOpen ? 'Hide sidebar' : 'Show sidebar'"
    @click="toggle"
  >
    <!-- Open, the button sits inside the panel it collapses, so it shows the
         panel glyph pointing at it; hidden, it is the TopBar's menu button and
         a hamburger is what that means. -->
    <AppIcon :name="ui.sidebarOpen ? 'sidebar-collapse' : 'bars-3'" class="h-5 w-5" />
  </button>
</template>
