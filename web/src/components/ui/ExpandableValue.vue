<script setup lang="ts">
// A monospace value block that truncates past `threshold` chars and offers an
// expand/collapse toggle. Shared by ConfigMap/Secret data panels and the Pod
// env table so long-value handling stays identical everywhere.

import { computed, ref } from "vue"

const props = withDefaults(
  defineProps<{ value: string; threshold?: number; collapsedHeightClass?: string }>(),
  { threshold: 400, collapsedHeightClass: "max-h-32" },
)

const expanded = ref(false)
const isLong = computed(() => props.value.length > props.threshold)
const display = computed(() =>
  isLong.value && !expanded.value ? `${props.value.slice(0, props.threshold)}…` : props.value,
)
</script>

<template>
  <div>
    <button
      v-if="isLong"
      type="button"
      class="mb-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
      @click="expanded = !expanded"
    >
      {{ expanded ? "collapse" : `expand (${value.length} chars)` }}
    </button>
    <pre
      class="overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 font-mono text-xs dark:bg-slate-800"
      :class="expanded ? 'max-h-[32rem]' : collapsedHeightClass"
    >{{ display }}</pre>
  </div>
</template>
