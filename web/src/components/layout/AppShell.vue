<script setup lang="ts">
import ToastContainer from "@/components/ui/ToastContainer.vue"

import Sidebar from "./Sidebar.vue"
import TopBar from "./TopBar.vue"
</script>

<template>
  <div class="flex h-full bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
    <Sidebar />
    <div class="flex min-w-0 flex-1 flex-col">
      <TopBar />
      <main class="min-h-0 flex-1 overflow-auto">
        <RouterView />
      </main>
    </div>
    <ToastContainer />
  </div>
</template>
