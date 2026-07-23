<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query"
import { computed, watch } from "vue"
import { useRoute } from "vue-router"

import { apiJson } from "@/api/http"
import type { K8sObjectList } from "@/api/types"
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

// Namespace listing may be forbidden for the user; fall back to manual input.
// Keyed by the active context so switching clusters refetches the new cluster's
// namespaces (and drives the reconciliation below). Gated on a real session so
// a switch to a not-yet-authorized context fires no tokenless request.
const query = useQuery({
  queryKey: computed(() => ["namespaces", auth.activeContext]),
  queryFn: () =>
    apiJson<K8sObjectList>("/k8s/api/v1/namespaces?limit=500", {
      headers: { Accept: "application/json" },
    }),
  enabled: computed(() => auth.isAuthenticated),
  staleTime: 60 * 1000,
  retry: false,
})

const names = computed(() =>
  (query.data.value?.items ?? [])
    .map((item) => item.metadata?.name ?? "")
    .filter((n) => n !== ""),
)

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
  <div v-if="!clusterScoped" class="flex items-center gap-2">
    <label class="text-xs uppercase tracking-wide text-slate-400" for="ns-select">Namespace</label>
    <!-- id lands on the inner <select>, which is what the label points at. -->
    <BaseSelect v-if="!query.isError.value" id="ns-select" v-model="ui.namespace" class="text-sm">
      <option value="">All namespaces</option>
      <option v-for="name in names" :key="name" :value="name">{{ name }}</option>
    </BaseSelect>
    <input
      v-else
      id="ns-select"
      v-model="ui.namespace"
      placeholder="namespace (empty = all)"
      class="w-48 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
    />
  </div>
</template>
