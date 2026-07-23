<script setup lang="ts">
import type { DiscoveryResource } from "@/api/types"
import { resourceListRoute } from "@/router"

defineProps<{
  res: DiscoveryResource
  pinned: boolean
  /** Dim the star: used in the Pinned section, where it is pure decoration. */
  dimStar?: boolean
}>()
defineEmits<{ togglePin: [] }>()
</script>

<template>
  <!-- The anchor is not draggable so a drag started anywhere on the row falls
       through to the reorder handler on the pinned-list wrapper instead of
       dragging the link URL. -->
  <div class="group flex items-center">
    <RouterLink
      :to="resourceListRoute(res)"
      :draggable="false"
      class="flex-1 truncate rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      active-class="bg-slate-100 font-medium text-slate-900 dark:bg-slate-800 dark:text-white"
      :title="res.group === '' ? res.resource : `${res.resource}.${res.group}`"
    >
      {{ res.kind }}
    </RouterLink>
    <button
      type="button"
      class="px-1 text-xs"
      :class="
        pinned
          ? dimStar
            ? 'text-amber-500/40 hover:text-amber-500'
            : 'text-amber-500'
          : 'text-transparent hover:!text-amber-500 group-hover:text-slate-300'
      "
      :title="pinned ? 'Unpin' : 'Pin'"
      :aria-label="pinned ? 'Unpin resource' : 'Pin resource'"
      @click="$emit('togglePin')"
    >
      ★
    </button>
  </div>
</template>
