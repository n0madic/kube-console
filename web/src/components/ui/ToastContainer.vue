<script setup lang="ts">
import { useToastStore } from "@/stores/toasts"

const store = useToastStore()

const kindClasses: Record<string, string> = {
  info: "border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-100",
  success:
    "border-green-300 bg-green-50 text-green-900 dark:border-green-700 dark:bg-green-950 dark:text-green-100",
  error: "border-red-300 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100",
}
</script>

<template>
  <div class="pointer-events-none fixed bottom-4 right-4 z-50 flex w-96 max-w-[90vw] flex-col gap-2">
    <div
      v-for="toast in store.toasts"
      :key="toast.id"
      class="pointer-events-auto flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm shadow-lg"
      :class="kindClasses[toast.kind]"
      role="alert"
    >
      <span class="break-words">{{ toast.message }}</span>
      <button
        type="button"
        class="shrink-0 font-bold opacity-60 hover:opacity-100"
        aria-label="Dismiss"
        @click="store.dismiss(toast.id)"
      >
        ×
      </button>
    </div>
  </div>
</template>
