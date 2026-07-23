<script setup lang="ts">
// Env tab: every environment variable the Pod's containers declare, gathered
// from container specs plus the referenced ConfigMaps and Secrets, in one
// globally name-sorted table. Secret-backed values stay masked behind the eye
// button (decoded in-tab only); long values truncate with an expand toggle.

import { useQuery } from "@tanstack/vue-query"
import { computed } from "vue"
import type { RouteLocationRaw } from "vue-router"

import { messageFromError } from "@/api/http"
import { getObject } from "@/api/k8s"
import type { K8sObject, ResourceRef } from "@/api/types"
import ExpandableValue from "@/components/ui/ExpandableValue.vue"
import RevealButton from "@/components/ui/RevealButton.vue"
import { useReveal } from "@/composables/useReveal"
import { resourceDetailRoute } from "@/router"
import { useAuthStore } from "@/stores/auth"
import { decodeBase64Utf8 } from "@/utils/base64"
import { buildEnvRows, collectEnvSourceNames, type EnvResolver, type EnvRow } from "@/utils/podEnv"

const props = defineProps<{ object: K8sObject }>()

const CM_REF: ResourceRef = { group: "", version: "v1", resource: "configmaps" }
const SECRET_REF: ResourceRef = { group: "", version: "v1", resource: "secrets" }
const VALUE_THRESHOLD = 200

const auth = useAuthStore()
// A different Pod's revealed secrets must not stay shown under the next Pod's
// rows: useReveal clears itself whenever the detail object's uid changes (same
// wiring as SecretDataPanel).
const { isRevealed, toggle } = useReveal<EnvRow>(rowKey, () => props.object.metadata?.uid)

type DataMap = EnvResolver["configMaps"]

// Fetch each referenced object once; an unreadable one (forbidden/not-found)
// maps to null so buildEnvRows can mark its values instead of failing the tab.
async function fetchMap(ref: ResourceRef, names: string[], namespace: string | undefined): Promise<DataMap> {
  const map: DataMap = new Map()
  const results = await Promise.allSettled(names.map((n) => getObject(ref, namespace, n)))
  results.forEach((res, i) => {
    const name = names[i] as string
    map.set(name, res.status === "fulfilled" ? ((res.value.data ?? {}) as Record<string, string>) : null)
  })
  return map
}

const namespace = computed(() => props.object.metadata?.namespace)
// Sorted, so the name list is a canonical cache key: two Pods referencing the
// same objects in a different declaration order must share one cache entry
// instead of forking it (buildEnvRows looks the maps up by name, so the order
// carries no meaning of its own).
const sourceNames = computed(() => {
  const names = collectEnvSourceNames(props.object)
  return { configMaps: [...names.configMaps].sort(), secrets: [...names.secrets].sort() }
})

// Cached per context/namespace/name-set via vue-query: switching tabs away and
// back re-mounts this component (ResourceDetailPage's tab body is v-else-if),
// but the query cache lives in the app-wide QueryClient, so it's served from
// cache instead of refetched — and two Pods sharing a ConfigMap/Secret in the
// same namespace share one entry. The key is context-scoped, so every end of
// session — Sign out, a 401, or the TTL guard — evicts these entries with the
// token that fetched them (`evictContextCaches`, stores/auth.ts). That matters
// here more than elsewhere: this is the one query family holding Secret data.
//
// The window is deliberately short (not the 5m of discovery, which is
// effectively immutable): ConfigMap/Secret values change under a running Pod,
// and the detail page's Refresh button only refetches the Pod object, so this
// is the only bound on how stale a rendered value can be.
const ENV_SOURCE_STALE_TIME = 60 * 1000

function envSourceQuery(ref: ResourceRef, names: () => string[]) {
  return useQuery({
    queryKey: computed(() => [
      "podEnvSource",
      auth.activeContext,
      namespace.value,
      ref.resource,
      names(),
    ]),
    queryFn: () => fetchMap(ref, names(), namespace.value),
    // Gated on a real session like every other context-scoped query: a switch
    // to a not-yet-authorized context must fire no tokenless request.
    enabled: computed(() => auth.isAuthenticated),
    staleTime: ENV_SOURCE_STALE_TIME,
  })
}

const configMapsQuery = envSourceQuery(CM_REF, () => sourceNames.value.configMaps)
const secretsQuery = envSourceQuery(SECRET_REF, () => sourceNames.value.secrets)

const errorText = computed(() => {
  const e = configMapsQuery.error.value ?? secretsQuery.error.value
  return e === null ? null : messageFromError(e)
})
// Both source maps must have resolved before the table may claim to be
// complete. Undefined data is not an empty Pod: with the queries gated off (a
// session past its TTL) they never run, and "No environment variables." would
// then be a false statement about the Pod rather than a pending fetch.
const resolved = computed(
  () => configMapsQuery.data.value !== undefined && secretsQuery.data.value !== undefined,
)
const rows = computed<EnvRow[]>(() => {
  const configMaps = configMapsQuery.data.value
  const secrets = secretsQuery.data.value
  if (configMaps === undefined || secrets === undefined) return []
  return buildEnvRows(props.object, { configMaps, secrets })
})

function rowKey(row: EnvRow): string {
  return `${row.containerType}:${row.container}:${row.name}`
}

function containerLabel(row: EnvRow): string {
  return row.containerType === "container" ? row.container : `${row.container} (${row.containerType})`
}

// Link to the backing ConfigMap/Secret detail page, when the value comes from one.
function sourceRoute(row: EnvRow): RouteLocationRaw | null {
  const ref = row.source.ref
  if (ref === undefined) return null
  return resourceDetailRoute(
    ref.kind === "ConfigMap" ? CM_REF : SECRET_REF,
    props.object.metadata?.namespace,
    ref.name,
  )
}

// Resolve each row's source route once per render (avoids repeated lookups in
// the template).
const rowViews = computed(() => rows.value.map((row) => ({ row, sourceLink: sourceRoute(row) })))
const hasRows = computed(() => rows.value.length > 0)
</script>

<template>
  <section class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
    <div class="mb-1 flex items-center justify-between gap-3">
      <h3 class="text-sm font-semibold uppercase tracking-wide text-slate-400">Environment</h3>
      <span v-if="hasRows" class="text-xs text-slate-400">{{ rows.length }} variables</span>
    </div>
    <p class="mb-3 text-xs text-slate-400">
      From container specs, ConfigMaps and Secrets. Secret values are masked — the eye button decodes
      them in this browser tab only.
    </p>

    <p v-if="errorText !== null" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      {{ errorText }}
    </p>
    <p v-else-if="!resolved" class="py-6 text-center text-sm text-slate-400">Loading...</p>
    <p v-else-if="!hasRows" class="py-6 text-center text-sm text-slate-400">
      No environment variables.
    </p>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-left text-xs uppercase text-slate-400">
          <tr>
            <th class="whitespace-nowrap px-2 py-1.5">Name</th>
            <!-- Value is the bulkiest field: let it absorb the free width. -->
            <th class="w-full px-2 py-1.5">Value</th>
            <th class="whitespace-nowrap px-2 py-1.5">Source</th>
            <th class="whitespace-nowrap px-2 py-1.5">Container</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="view in rowViews"
            :key="rowKey(view.row)"
            class="border-t border-slate-100 align-top dark:border-slate-800"
          >
            <td class="whitespace-nowrap px-2 py-1.5 font-mono text-xs font-medium">{{ view.row.name }}</td>
            <td class="px-2 py-1.5">
              <!-- Eye stays on the value's first line; the wide Value column
                   absorbs its width, so the value is not visually shrunk. -->
              <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                  <template v-if="view.row.kind === 'secret'">
                    <ExpandableValue
                      v-if="isRevealed(view.row)"
                      :value="decodeBase64Utf8(view.row.value)"
                      :threshold="VALUE_THRESHOLD"
                    />
                    <span v-else class="font-mono text-xs text-slate-400">••••••••</span>
                  </template>
                  <ExpandableValue
                    v-else-if="(view.row.kind === 'literal' || view.row.kind === 'configmap') && view.row.value !== ''"
                    :value="view.row.value"
                    :threshold="VALUE_THRESHOLD"
                  />
                  <span v-else class="font-mono text-xs italic text-slate-400">{{ view.row.value || "—" }}</span>
                </div>
                <RevealButton
                  v-if="view.row.kind === 'secret'"
                  :revealed="isRevealed(view.row)"
                  @toggle="toggle(view.row)"
                />
              </div>
            </td>
            <td class="whitespace-nowrap px-2 py-1.5 text-xs text-slate-500 dark:text-slate-400">
              <template v-if="view.row.source.ref !== undefined">
                {{ view.row.source.ref.kind }}
                <RouterLink
                  v-if="view.sourceLink !== null"
                  :to="view.sourceLink"
                  class="font-mono text-blue-600 hover:underline dark:text-blue-400"
                >{{ view.row.source.ref.name }}</RouterLink>
                <span v-else class="font-mono">{{ view.row.source.ref.name }}</span>
                <span v-if="view.row.source.key !== undefined"> → {{ view.row.source.key }}</span>
              </template>
              <span v-else>{{ view.row.source.label }}</span>
            </td>
            <td class="whitespace-nowrap px-2 py-1.5 text-xs text-slate-500 dark:text-slate-400">
              {{ containerLabel(view.row) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
