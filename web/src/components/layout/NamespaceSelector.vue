<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query"
import { computed, watch } from "vue"
import { useRoute } from "vue-router"

import { fetchNamespaces } from "@/api/k8s"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import { useDiscovery } from "@/composables/useDiscovery"
import { useAuthStore } from "@/stores/auth"
import { useUiStore } from "@/stores/ui"

const ui = useUiStore()
const auth = useAuthStore()
const route = useRoute()
const discovery = useDiscovery()

// Cluster-scoped resources must not show a namespace selector. Only
// the resource list/detail routes carry group/version/resource params; other
// routes (e.g. overview) keep the selector. Until discovery resolves, the
// entry is undefined and we keep the selector visible (assume namespaced).
const clusterScoped = computed(() => {
  if (route.name !== "resource-list" && route.name !== "resource-detail") return false
  const { group, version, resource } = route.params
  if (typeof group !== "string" || typeof version !== "string" || typeof resource !== "string") {
    return false
  }
  const entry = discovery.findResource(group, version, resource)
  return entry !== undefined && entry.namespaced === false
})

// The selector lives in the TopBar, so it is mounted for the whole session and
// nothing ever remounts this query: without an interval a namespace created
// after the first fetch (by anyone, this app included) never appeared until a
// reload or a cluster switch, and `refetchOnWindowFocus` is off app-wide. The
// list is small and changes rarely, so one poll a minute — the same number as
// the staleTime it replaces the effect of — is the whole freshness budget.
const NAMESPACES_REFRESH_MS = 60 * 1000

// Namespace listing may be forbidden for the user; fall back to manual input.
// Keyed by the active context so switching clusters refetches the new cluster's
// namespaces (and drives the reconciliation below). Gated on a real session so
// a switch to a not-yet-authorized context fires no tokenless request.
const query = useQuery({
  queryKey: computed(() => ["namespaces", auth.activeContext]),
  queryFn: () => fetchNamespaces(),
  enabled: computed(() => auth.isAuthenticated),
  staleTime: NAMESPACES_REFRESH_MS,
  // Stop polling once the list has failed: a namespace-scoped token gets a 403
  // that no amount of retrying resolves, and `retry: false` says as much for
  // the first attempt — an interval would reinstate exactly that loop, once a
  // minute, for as long as the tab stays open. A context switch or a reload
  // re-arms it, which is when the verdict can actually have changed.
  refetchInterval: (q) => (q.state.status === "error" ? false : NAMESPACES_REFRESH_MS),
  retry: false,
})

const names = computed(() =>
  (query.data.value?.items ?? [])
    .map((item) => item.metadata?.name ?? "")
    .filter((n) => n !== ""),
)

// Past the walker's page cap the list is incomplete; the marker option below
// says so, or a capped list would silently present itself as the whole cluster.
const truncated = computed(() => (query.data.value?.metadata?.continue ?? "") !== "")

// The selected namespace must always have an option: with a v-model value no
// <option> matches (list still loading, or the namespace is past the cap) the
// select renders blank while every list on screen stays filtered by it — and
// the value could not even be reselected.
const selectedMissing = computed(() => ui.namespace !== "" && !names.value.includes(ui.namespace))

// Reconcile the selected namespace when a context's namespace list loads: keep
// a same-named namespace across clusters, otherwise fall back to "all". Only
// runs on a complete successful list — on a 403/error the free-text input is
// shown and the selection is left untouched, and a truncated page (continue
// token: cluster has >500 namespaces) cannot prove absence, so it never resets.
watch(
  () => query.data.value,
  (data) => {
    if (data === undefined) return
    if ((data.metadata?.continue ?? "") !== "") return
    if (ui.namespace !== "" && !names.value.includes(ui.namespace)) {
      ui.namespace = ""
    }
  },
  { immediate: true },
)
</script>

<template>
  <div v-if="!clusterScoped" class="flex min-w-0 items-center gap-2">
    <!-- The caption is only a caption: below `sm` the header has no width for
         it, but it stays the select's accessible name (`sr-only`, never
         `hidden`, which would take it out of the a11y tree with the rest). -->
    <label
      class="sr-only text-xs uppercase tracking-wide text-slate-400 sm:not-sr-only"
      for="ns-select"
    >
      Namespace
    </label>
    <!-- id lands on the inner <select>, which is what the label points at. -->
    <!-- Shrinking is BaseSelect's own business (it owns the box the caret is
         positioned against), so nothing about it is passed from here. -->
    <BaseSelect v-if="!query.isError.value" id="ns-select" v-model="ui.namespace" class="text-sm">
      <option value="">All namespaces</option>
      <option v-if="selectedMissing" :value="ui.namespace">{{ ui.namespace }}</option>
      <option v-for="name in names" :key="name" :value="name">{{ name }}</option>
      <!-- Never selectable; the value only has to match no real namespace,
           and DNS-1123 names cannot contain underscores. -->
      <option v-if="truncated" disabled value="__truncated__">… more namespaces not listed</option>
    </BaseSelect>
    <!-- `.lazy`: a plain v-model commits on every keystroke, and this value is
         watched by the list page (a full bounded collection walk), the events
         card (a 1000-item fetch) and the Overview's metrics loop — so typing
         "kube-system" fired eleven of each, one per prefix. The select branch
         has no such problem: it emits once per pick. -->
    <input
      v-else
      id="ns-select"
      v-model.lazy="ui.namespace"
      placeholder="namespace (empty = all)"
      class="w-32 min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm sm:w-48 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
    />
  </div>
</template>
