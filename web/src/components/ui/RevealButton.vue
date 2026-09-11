<script setup lang="ts">
// Eye / eye-off toggle for masked values (Secret data, secret-backed env vars).
// Stateless: the parent owns the revealed flag and reacts to `toggle`.

import IconButton from "@/components/ui/IconButton.vue"

defineProps<{ revealed: boolean }>()
defineEmits<{ toggle: [] }>()
</script>

<template>
  <IconButton
    :name="revealed ? 'eye-slash' : 'eye'"
    :title="revealed ? 'Hide value' : 'Reveal decoded value'"
    :aria-label="revealed ? 'Hide value' : 'Reveal decoded value'"
    @click="$emit('toggle')"
  />
</template>
