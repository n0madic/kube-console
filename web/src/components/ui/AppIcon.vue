<script setup lang="ts">
// Renders one glyph from `utils/icons.ts`.
//
// Sizing and color are the caller's: pass the utilities (`class="h-4 w-4"`),
// because a default here would collide with them and stylesheet order, not
// class order, would decide the winner. The glyph is always `aria-hidden` —
// every icon in this UI sits inside an element that carries the label.

import { computed } from "vue"

import { ICONS, type IconDef, type IconName } from "@/utils/icons"

const props = defineProps<{ name: IconName }>()

const icon = computed<IconDef>(() => ICONS[props.name])
</script>

<template>
  <svg
    :viewBox="icon.view"
    :fill="icon.stroke === undefined ? 'currentColor' : 'none'"
    :stroke="icon.stroke === undefined ? undefined : 'currentColor'"
    :stroke-width="icon.stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="d in icon.paths" :key="d" :d="d" />
  </svg>
</template>
