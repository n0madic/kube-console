<script setup lang="ts">
// The build serving this SPA, in the sidebar footer: a git tag for a release,
// a short commit for a branch build. Reference information, not operational —
// which is why it has no TopBar twin the way ClusterName does, and simply goes
// away with the sidebar on a narrow viewport.
//
// Its own component rather than a few lines of Sidebar, for the same reason
// ClusterName is: it reads the contexts query, and the sidebar's spec must not
// have to stand up vue-query to render a nav list.

import { computed } from "vue"

import { useContextsQuery } from "@/composables/useContexts"

// Shared by key with the switcher, the page title and ClusterName, so this adds
// no request: the version rides along on a response already fetched once per
// session and cached for 5m.
const query = useContextsQuery()

// Absent until the query answers, and absent from an older backend that does
// not send the field — in both cases the footer renders nothing rather than a
// placeholder, since "unknown build" is worse than no line at all.
const version = computed(() => (query.data.value?.version ?? "").trim())
</script>

<template>
  <div
    v-if="version !== ''"
    class="border-t border-slate-200 px-4 py-2 text-xs text-slate-400 dark:border-slate-700 dark:text-slate-500"
  >
    <!-- Truncated in a 16rem sidebar with the whole string in the tooltip, like
         the cluster label above it: a tag can be as long as the operator's tag
         convention makes it. -->
    <span class="block truncate" :title="version">{{ version }}</span>
  </div>
</template>
