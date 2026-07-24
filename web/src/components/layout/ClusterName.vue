<script setup lang="ts">
// The operator's --cluster-name on screen, not only in the tab title: a label
// that says which estate this is has to be readable while looking at the page,
// and the tab title is exactly what is not visible then.
//
// Its own component rather than a few lines of Sidebar, for the same reason
// ClusterSelector is: it reads the contexts query, and the sidebar's spec must
// not have to stand up vue-query to render a nav list.
//
// It has two homes: a row of the sidebar, and the TopBar while the sidebar is
// hidden (`inline`) — otherwise collapsing the sidebar, which happens by itself
// on a narrow viewport, would leave nothing on screen naming the cluster being
// acted on. Same component, so the two cannot drift.

import { computed } from "vue"

import { useContextsQuery } from "@/composables/useContexts"

const props = defineProps<{ inline?: boolean }>()

// Shared by key with the switcher and the page title, so this adds no request.
const query = useContextsQuery()

// Only the configured name. The active context is named by the switcher right
// below, and it is unset here on purpose: the two answer different questions,
// and for the single synthesized "default" context (in-cluster, --api-server)
// the switcher is hidden entirely — which is the case this label exists for.
const name = computed(() => (query.data.value?.clusterName ?? "").trim())
</script>

<template>
  <!-- Full class in one expression: the sidebar row is a bordered band of its
       own, the TopBar one is an item in an existing row. Inline it is capped
       and `shrink-0`, so a long *identity* next to it cannot squeeze the name
       down (a four-letter cluster was rendering as "t..") — the cap is what
       bounds it instead, and the name truncates inside that. -->
  <div
    v-if="name !== ''"
    :class="
      props.inline
        ? 'flex min-w-0 max-w-[8rem] shrink-0 items-baseline gap-2 sm:max-w-[12rem]'
        : 'flex min-w-0 items-baseline gap-2 border-b border-slate-200 px-4 py-2 dark:border-slate-700'
    "
  >
    <!-- In the TopBar the caption goes below `sm`: the name identifies the
         cluster, the word "Cluster" only labels it, and the row has no width
         for both next to the namespace selector. -->
    <span
      :class="
        props.inline
          ? 'hidden shrink-0 text-xs uppercase tracking-wide text-slate-400 sm:inline'
          : 'shrink-0 text-xs uppercase tracking-wide text-slate-400'
      "
      >Cluster</span
    >
    <!-- Up to 64 runes, and narrow next to a 16rem sidebar: truncated, with the
         whole thing in the tooltip. -->
    <span
      class="truncate text-sm font-semibold text-slate-700 dark:text-slate-200"
      :title="name"
    >{{ name }}</span>
  </div>
</template>
