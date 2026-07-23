<script setup lang="ts">
import BaseButton from "@/components/ui/BaseButton.vue"

defineProps<{
  loading: boolean
  watchDegraded: boolean
  /** True when the view is truncated and Enter triggers a full server scan. */
  deepSearch: boolean
}>()
const emit = defineEmits<{ refresh: []; create: []; search: [] }>()

const filter = defineModel<string>("filter", { required: true })
const labelSelector = defineModel<string>("labelSelector", { required: true })
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-700 dark:bg-slate-900">
    <input
      v-model="filter"
      type="search"
      :placeholder="deepSearch ? 'Filter · Enter = search all' : 'Filter...'"
      :title="
        deepSearch
          ? 'The list is larger than the loaded part: typing filters loaded rows, Enter searches the whole collection by name'
          : 'Filters the fully loaded collection'
      "
      class="w-64 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800"
      @keydown.enter.prevent="emit('search')"
    />
    <input
      v-model="labelSelector"
      type="text"
      placeholder="labelSelector (app=web,tier!=cache)"
      spellcheck="false"
      class="w-72 rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800"
      @keydown.enter="emit('refresh')"
    />
    <BaseButton :disabled="loading" @click="emit('refresh')">
      {{ loading ? "Loading..." : "Refresh" }}
    </BaseButton>
    <span
      v-if="watchDegraded"
      class="text-xs text-amber-600 dark:text-amber-400"
      title="Live updates unavailable; use Refresh"
    >
      watch unavailable
    </span>
    <div class="flex-1"></div>
    <BaseButton variant="primary" @click="emit('create')">Create</BaseButton>
  </div>
</template>
