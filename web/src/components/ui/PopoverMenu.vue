<script setup lang="ts">
// A labelled button that drops a small panel of controls below itself — for
// settings that are read often but changed rarely, which do not earn a
// permanent slot in a crowded toolbar. The panel is the caller's slot; this
// owns only open/close: the trigger toggles it, a click outside or Escape
// dismisses it, and Escape is consumed (`preventDefault`) because `AppShell`'s
// drawer handler keys on `defaultPrevented` and would otherwise close the
// sidebar drawer under it — the same rule `ContextListbox` follows.

import { ref, useId } from "vue"

import AppIcon from "@/components/ui/AppIcon.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import { useDismissOnOutside } from "@/composables/useDismissOnOutside"
import type { IconName } from "@/utils/icons"

defineProps<{
  /** Accessible name of the trigger; its visible text unless `icon` is set. */
  label: string
  /** Icon-only trigger: the label moves into title/aria-label. */
  icon?: IconName
}>()

const root = ref<HTMLElement | null>(null)
const trigger = ref<InstanceType<typeof BaseButton> | null>(null)
const open = ref(false)
const panelId = useId()

function toggle(): void {
  open.value = !open.value
}

function close(): void {
  open.value = false
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape" || !open.value) return
  e.preventDefault()
  close()
  ;(trigger.value?.$el as HTMLElement | undefined)?.focus()
}

useDismissOnOutside(root, close)
</script>

<template>
  <div ref="root" class="relative" @keydown="onKeydown">
    <!-- BaseButton, so the trigger matches the buttons it stands beside. -->
    <!-- haspopup "dialog", not "true" (= menu): the panel holds form controls,
         not menuitems, and a screen reader announcing "menu button" would
         expect arrow-key navigation over items that are not there. -->
    <BaseButton
      ref="trigger"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-controls="open ? panelId : undefined"
      :title="icon === undefined ? undefined : label"
      :aria-label="icon === undefined ? undefined : label"
      @click="toggle"
    >
      <AppIcon v-if="icon !== undefined" :name="icon" class="h-4 w-4" />
      <template v-else>
        {{ label }}
        <AppIcon name="caret-down" class="h-4 w-4 shrink-0 text-slate-400" />
      </template>
    </BaseButton>
    <div
      v-if="open"
      :id="panelId"
      class="absolute left-0 z-30 mt-1 flex min-w-max flex-col gap-2 rounded-md border border-slate-300 bg-white p-3 text-sm shadow-lg dark:border-slate-600 dark:bg-slate-800"
    >
      <slot />
    </div>
  </div>
</template>
