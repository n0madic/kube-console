<script setup lang="ts">
import BaseButton from "@/components/ui/BaseButton.vue"

defineProps<{
  hasNextPage: boolean
  paged: boolean
  loading: boolean
  rowCount: number
}>()
const emit = defineEmits<{ next: []; restart: [] }>()
</script>

<template>
  <div
    class="flex items-center justify-between border-t border-slate-200 bg-white px-4 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
  >
    <span class="text-slate-500 dark:text-slate-400">{{ rowCount }} items on this page</span>
    <div class="flex items-center gap-2">
      <BaseButton v-if="paged" variant="ghost" :disabled="loading" @click="emit('restart')">
        ⟲ Back to start
      </BaseButton>
      <BaseButton v-if="hasNextPage" :disabled="loading" @click="emit('next')">
        Next page →
      </BaseButton>
    </div>
  </div>
</template>
