<script setup lang="ts">
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui"

defineProps<{ title: string; wide?: boolean }>()
const open = defineModel<boolean>("open", { required: true })
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/50" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg bg-white p-5 shadow-xl dark:bg-slate-900 dark:text-slate-100"
        :class="wide === true ? 'w-[min(64rem,95vw)]' : 'w-[min(36rem,90vw)]'"
      >
        <DialogTitle class="mb-3 text-lg font-semibold">{{ title }}</DialogTitle>
        <slot />
        <div v-if="$slots.footer" class="mt-4 flex justify-end gap-2">
          <slot name="footer" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
