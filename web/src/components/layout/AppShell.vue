<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from "vue"
import { useRoute } from "vue-router"

import ToastContainer from "@/components/ui/ToastContainer.vue"
import { useUiStore } from "@/stores/ui"

import Sidebar from "./Sidebar.vue"
import TopBar from "./TopBar.vue"

const ui = useUiStore()
const route = useRoute()

// Both dismissal paths are inert on a wide viewport: closeSidebar only touches
// the drawer state, which is not read there.
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") ui.closeSidebar()
}

onMounted(() => window.addEventListener("keydown", onKeydown))
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))

// The drawer covers exactly the content its own links lead to.
watch(
  () => route.fullPath,
  () => ui.closeSidebar(),
)
</script>

<template>
  <div class="flex h-full bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
    <Sidebar />
    <!-- z-30 backdrop under the z-40 drawer. BaseDialog portals to the body
         with z-40/z-50 and lands later in the DOM, so dialogs stay on top. -->
    <div
      v-if="ui.narrowViewport && ui.sidebarOpen"
      class="fixed inset-0 z-30 bg-slate-900/50"
      @click="ui.closeSidebar()"
    />
    <div class="flex min-w-0 flex-1 flex-col">
      <TopBar />
      <main class="min-h-0 flex-1 overflow-auto">
        <RouterView />
      </main>
    </div>
    <ToastContainer />
  </div>
</template>
