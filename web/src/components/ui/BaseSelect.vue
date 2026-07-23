<script setup lang="ts" generic="T">
// A native <select> wearing the app's own caret. The browser draws a different
// arrow in every engine — and none of them is the `caret-down` that the
// hand-built pickers (EditableCombobox, ContextListbox) draw — so a toolbar
// holding both read as two kinds of control. `appearance-none` plus one
// AppIcon is the whole trick: the popup, the keyboard handling and the
// accessibility tree stay the platform's, which is exactly why these are still
// <select>s and not another listbox of ours.

import AppIcon from "@/components/ui/AppIcon.vue"

withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false })

// Generic: callers bind numbers ("poll every 15s"), strings and unions of both
// ("all" | number for a log tail), and the option values are theirs.
const model = defineModel<T>({ required: true })

// Everything the caller passes belongs on the <select>, not on the positioning
// wrapper: `id` has a <label for=…> pointing at it, and a `class` is meant to
// size the control itself. A passed class *merges* with the ones below rather
// than replacing them, so pass only utilities that do not collide with them
// (`text-sm`, a width) — with two utilities for one property, stylesheet order
// decides the winner, not class order.
defineOptions({ inheritAttrs: false })
</script>

<template>
  <span class="relative inline-flex items-center">
    <select
      v-model="model"
      v-bind="$attrs"
      :disabled="disabled"
      class="appearance-none [-webkit-appearance:none] rounded-md border border-slate-300 bg-white py-1 pl-2 pr-7 disabled:cursor-not-allowed dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
    >
      <slot />
    </select>
    <!-- pointer-events-none: the caret sits over the select, and a click on it
         must still open the popup. -->
    <AppIcon
      name="caret-down"
      class="pointer-events-none absolute right-1.5 h-4 w-4 text-slate-400"
    />
  </span>
</template>
