<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue"
import { useRoute } from "vue-router"

import ToastContainer from "@/components/ui/ToastContainer.vue"
import { useUiStore } from "@/stores/ui"

import Sidebar from "./Sidebar.vue"
import TopBar from "./TopBar.vue"

const ui = useUiStore()
const route = useRoute()

/** The drawer overlays the content, so it is modal: what is behind it goes
 * `inert` (unfocusable, unclickable and gone from the accessibility tree in one
 * attribute), which is also what keeps Tab inside the drawer — with nothing
 * else focusable in the document the cycle is the trap, no JS loop needed.
 * There is no body scroll lock because there is nothing to lock: html/body/#app
 * are `h-full` and the scroller is `<main>`, inside the inert subtree; the
 * backdrop's own `touch-none overscroll-none` stops a drag on it from chaining
 * anywhere. */
const modal = computed(() => ui.narrowViewport && ui.sidebarOpen)

// Escape dismisses the drawer, and nothing else: on a wide viewport it must not
// collapse the in-flow sidebar. `defaultPrevented` keeps it from firing on top
// of a nested handler — the cluster listbox inside the sidebar cancels its own
// Escape but does not stop it from reaching window, so closing that popup used
// to close the whole drawer with it.
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented) return
  if (!ui.narrowViewport || !ui.sidebarOpen) return
  ui.closeSidebar()
}

onMounted(() => window.addEventListener("keydown", onKeydown))
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))

// The drawer covers exactly the content its own links lead to. The links close
// it themselves (a tap on the page already open changes no fullPath and would
// otherwise leave the drawer sitting over it); this catches navigation from
// anywhere else — a context switch redirecting to /login, the 401 handler.
watch(
  () => route.fullPath,
  // A navigation, like the sidebar links: no focus handoff.
  () => ui.closeSidebar(false),
)
</script>

<template>
  <div class="flex h-full bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
    <Sidebar />
    <!-- z-30 backdrop under the z-40 drawer. BaseDialog portals to the body
         with z-40/z-50 and lands later in the DOM, so dialogs stay on top. -->
    <div
      v-if="modal"
      class="fixed inset-0 z-30 touch-none overscroll-none bg-slate-900/50"
      aria-hidden="true"
      @click="ui.closeSidebar()"
    />
    <!-- `|| undefined` because `inert` is not one of Vue's special boolean
         attributes: bound as `false` it would be written out as inert="false",
         and any inert attribute at all makes the subtree inert. -->
    <div class="flex min-w-0 flex-1 flex-col" :inert="modal || undefined">
      <TopBar />
      <main class="min-h-0 flex-1 overflow-auto">
        <RouterView />
      </main>
    </div>
    <ToastContainer />
  </div>
</template>
