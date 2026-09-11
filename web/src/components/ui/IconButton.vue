<script setup lang="ts">
// The bare icon-only button: a glyph with a hover tint and no border, for
// controls that belong to a value or a field rather than to a button row
// (RevealButton, the search field's previous/next). Toolbar buttons are
// BaseButton. Icon-only, so every use must carry `title`/`aria-label` — they
// fall through to the button along with `@click`.

import AppIcon from "@/components/ui/AppIcon.vue"
import type { IconName } from "@/utils/icons"

withDefaults(defineProps<{ name: IconName; disabled?: boolean }>(), { disabled: false })
</script>

<template>
  <button
    type="button"
    :disabled="disabled"
    class="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
  >
    <AppIcon :name="name" class="h-4 w-4" />
  </button>
</template>
