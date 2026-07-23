<script setup lang="ts">
import { computed, ref } from "vue"

import type { K8sObject } from "@/api/types"
import { useDiscovery } from "@/composables/useDiscovery"
import { resourceDetailRoute } from "@/router"
import { formatAge } from "@/utils/units"
import type { RouteLocationRaw } from "vue-router"

const props = defineProps<{ object: K8sObject }>()

const discovery = useDiscovery()

const meta = computed(() => props.object.metadata ?? {})
const labels = computed(() => Object.entries(meta.value.labels ?? {}))
const annotations = computed(() => Object.entries(meta.value.annotations ?? {}))

// Long annotation values (e.g. last-applied-configuration) start collapsed.
const LONG_ANNOTATION = 140
const expandedAnnotations = ref<Set<string>>(new Set())

function isLong(value: string): boolean {
  return value.length > LONG_ANNOTATION
}

function toggleAnnotation(key: string): void {
  const next = new Set(expandedAnnotations.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedAnnotations.value = next
}

/** Owner reference → detail route when the kind is discoverable. */
function ownerRoute(owner: { apiVersion: string; kind: string; name: string }): RouteLocationRaw | null {
  const entry = discovery.findByKind(owner.apiVersion, owner.kind)
  if (entry === undefined) return null
  const ref = { group: entry.group, version: entry.version, resource: entry.resource }
  // Owner references never cross namespaces: a namespaced owner lives in the
  // same namespace as this object.
  return resourceDetailRoute(ref, entry.namespaced ? meta.value.namespace : undefined, owner.name)
}

// Resolve each owner's route once per render instead of calling ownerRoute
// twice per owner (v-if + :to) in the template.
const owners = computed(() =>
  (meta.value.ownerReferences ?? []).map((owner) => ({ owner, to: ownerRoute(owner) })),
)
</script>

<template>
  <section class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
    <h3 class="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Metadata</h3>
    <dl class="grid grid-cols-[10rem_1fr] gap-y-1.5 text-sm">
      <dt class="text-slate-500 dark:text-slate-400">Name</dt>
      <dd class="break-all font-mono">{{ meta.name }}</dd>
      <template v-if="meta.namespace !== undefined">
        <dt class="text-slate-500 dark:text-slate-400">Namespace</dt>
        <dd class="font-mono">{{ meta.namespace }}</dd>
      </template>
      <dt class="text-slate-500 dark:text-slate-400">Created</dt>
      <dd>
        {{ meta.creationTimestamp }}
        <span class="text-slate-400">({{ formatAge(meta.creationTimestamp) }} ago)</span>
      </dd>
      <dt class="text-slate-500 dark:text-slate-400">UID</dt>
      <dd class="break-all font-mono text-xs">{{ meta.uid }}</dd>
      <template v-if="owners.length > 0">
        <dt class="text-slate-500 dark:text-slate-400">Owners</dt>
        <dd>
          <template v-for="{ owner, to } in owners" :key="owner.uid ?? owner.name">
            <RouterLink
              v-if="to !== null"
              :to="to"
              class="mr-2 text-blue-600 hover:underline dark:text-blue-400"
            >
              {{ owner.kind }}/{{ owner.name }}
            </RouterLink>
            <span v-else class="mr-2">{{ owner.kind }}/{{ owner.name }}</span>
          </template>
        </dd>
      </template>
    </dl>

    <template v-if="labels.length > 0">
      <h4 class="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">Labels</h4>
      <div class="flex flex-wrap gap-1">
        <span
          v-for="[key, value] in labels"
          :key="key"
          class="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300"
        >
          {{ key }}={{ value }}
        </span>
      </div>
    </template>

    <template v-if="annotations.length > 0">
      <h4 class="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Annotations
      </h4>
      <dl class="space-y-0.5 text-xs">
        <div v-for="[key, value] in annotations" :key="key" class="flex gap-2">
          <dt class="shrink-0 font-mono text-slate-500 dark:text-slate-400">{{ key }}:</dt>
          <dd class="min-w-0 flex-1 font-mono text-slate-700 dark:text-slate-300">
            <template v-if="!isLong(value)">
              <span class="break-all">{{ value }}</span>
            </template>
            <template v-else>
              <pre
                v-if="expandedAnnotations.has(key)"
                class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 dark:bg-slate-800"
              >{{ value }}</pre>
              <span v-else class="break-all">{{ value.slice(0, LONG_ANNOTATION) }}…</span>
              <button
                type="button"
                class="ml-1 text-blue-600 hover:underline dark:text-blue-400"
                @click="toggleAnnotation(key)"
              >
                {{ expandedAnnotations.has(key) ? "collapse" : `expand (${value.length} chars)` }}
              </button>
            </template>
          </dd>
        </div>
      </dl>
    </template>
  </section>
</template>
