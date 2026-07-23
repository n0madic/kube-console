<script setup lang="ts">
// Eye / eye-off toggle for masked values (Secret data, secret-backed env vars).
// Stateless: the parent owns the revealed flag and reacts to `toggle`.

import AppIcon from "@/components/ui/AppIcon.vue"

defineProps<{ revealed: boolean }>()
defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    type="button"
    class="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    :title="revealed ? 'Hide value' : 'Reveal decoded value'"
    :aria-label="revealed ? 'Hide value' : 'Reveal decoded value'"
    @click="$emit('toggle')"
  >
    <AppIcon :name="revealed ? 'eye-slash' : 'eye'" class="h-4 w-4" />
  </button>
</template>
