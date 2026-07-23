<script setup lang="ts">
// The operator's --cluster-name on screen, not only in the tab title: a label
// that says which estate this is has to be readable while looking at the page,
// and the tab title is exactly what is not visible then.
//
// Its own component rather than a few lines of Sidebar, for the same reason
// ClusterSelector is: it reads the contexts query, and the sidebar's spec must
// not have to stand up vue-query to render a nav list.

import { computed } from "vue"

import { useContextsQuery } from "@/composables/useContexts"

// Shared by key with the switcher and the page title, so this adds no request.
const query = useContextsQuery()

// Only the configured name. The active context is named by the switcher right
// below, and it is unset here on purpose: the two answer different questions,
// and for the single synthesized "default" context (in-cluster, --api-server)
// the switcher is hidden entirely — which is the case this label exists for.
const name = computed(() => (query.data.value?.clusterName ?? "").trim())
</script>

<template>
  <div
    v-if="name !== ''"
    class="flex min-w-0 items-baseline gap-2 border-b border-slate-200 px-4 py-2 dark:border-slate-700"
  >
    <span class="shrink-0 text-xs uppercase tracking-wide text-slate-400">Cluster</span>
    <!-- Up to 64 runes, and narrow next to a 16rem sidebar: truncated, with the
         whole thing in the tooltip. -->
    <span
      class="truncate text-sm font-semibold text-slate-700 dark:text-slate-200"
      :title="name"
    >{{ name }}</span>
  </div>
</template>
