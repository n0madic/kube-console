<script setup lang="ts">
import { computed } from "vue"
import { useRoute, useRouter } from "vue-router"

import ContextListbox from "@/components/ui/ContextListbox.vue"
import { useContexts } from "@/composables/useContexts"
import { useAuthStore } from "@/stores/auth"
import { contextItems } from "@/utils/contextItems"

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const { contexts } = useContexts()

const items = computed(() =>
  contextItems(
    contexts.value.map((c) => c.name),
    (name) => auth.hasSession(name),
  ),
)

// Only meaningful with more than one cluster; hidden otherwise (single context,
// --api-server, in-cluster). Same rule as the login page's picker.
const show = computed(() => items.value.length > 1)

function switchContext(name: string): void {
  if (name === auth.activeContext) return
  // Point at the new cluster. The namespace is NOT reset here — NamespaceSelector
  // reconciles it once the new cluster's namespace list loads (keeping a
  // same-named namespace, otherwise "all").
  auth.setActiveContext(name)
  if (!auth.isAuthenticated) {
    // No token for the target cluster yet: log in (bound to this context) and
    // come back to the current view — collapsed to its list for a detail page,
    // since the object may not exist in the new cluster.
    const redirect =
      route.name === "resource-detail"
        ? router.resolve({
            name: "resource-list",
            params: {
              group: route.params.group,
              version: route.params.version,
              resource: route.params.resource,
            },
          }).fullPath
        : route.fullPath
    void router.push({ name: "login", query: { redirect } })
    return
  }
  if (route.name === "resource-detail") {
    // The object may not exist in the new cluster; collapse to its list so the
    // detail page (and its watch/logs/terminal) unmounts cleanly instead of 404.
    void router.push({
      name: "resource-list",
      params: {
        group: route.params.group,
        version: route.params.version,
        resource: route.params.resource,
      },
    })
    return
  }
  // Otherwise stay put — context-scoped query keys and watch deps refetch the
  // current view against the new cluster.
}
</script>

<template>
  <div v-if="show" class="border-b border-slate-200 px-3 py-2 dark:border-slate-700">
    <ContextListbox :items="items" :selected="auth.activeContext" @select="switchContext" />
  </div>
</template>
