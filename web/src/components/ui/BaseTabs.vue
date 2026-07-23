<script setup lang="ts">
defineProps<{ tabs: Array<{ id: string; label: string }> }>()
const model = defineModel<string>({ required: true })
</script>

<template>
  <nav class="flex gap-1 border-b border-slate-200 dark:border-slate-700" role="tablist">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      role="tab"
      type="button"
      :aria-selected="model === tab.id"
      class="-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors"
      :class="
        model === tab.id
          ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
      "
      @click="model = tab.id"
    >
      {{ tab.label }}
    </button>
  </nav>
</template>
