<script setup lang="ts">
import { computed, ref } from "vue"

import type { K8sObject } from "@/api/types"
import { compactSpec, pruneEmpty } from "@/utils/fieldFilter"
import { buildFieldTree } from "@/utils/fieldTree"
import { topLevelFields } from "@/utils/topLevelFields"

import ConditionsTable from "./ConditionsTable.vue"
import ConfigMapDataPanel from "./ConfigMapDataPanel.vue"
import EventsCard from "./EventsCard.vue"
import MetadataCard from "./MetadataCard.vue"
import NodePodsCard from "./NodePodsCard.vue"
import ObjectFieldTree from "./ObjectFieldTree.vue"
import RelatedResourcesCard from "./RelatedResourcesCard.vue"
import SecretDataPanel from "./SecretDataPanel.vue"

const props = defineProps<{ object: K8sObject }>()

const isSecret = computed(
  () => props.object.kind === "Secret" && (props.object.apiVersion ?? "v1") === "v1",
)

const isConfigMap = computed(
  () => props.object.kind === "ConfigMap" && (props.object.apiVersion ?? "v1") === "v1",
)

const isNode = computed(
  () => props.object.kind === "Node" && (props.object.apiVersion ?? "v1") === "v1",
)

// Fields outside apiVersion/kind/metadata/spec/status (an Event's type/reason/
// message, a StorageClass's provisioner, …). Rendered by the same field tree,
// and only when the object actually has some.
const detailNodes = computed(() => {
  const fields = topLevelFields(props.object)
  return fields === null ? [] : buildFieldTree(fields)
})

function compactJson(value: unknown): string {
  if (value === undefined || value === null) return ""
  return JSON.stringify(value, null, 2)
}

// Raw view always shows the untouched object — the escape hatch to everything.
const specJson = computed(() => compactJson(props.object.spec))
const statusJson = computed(() => compactJson(props.object.status))

const rawSpec = ref(false)
const rawStatus = ref(false)
// Compact hides defaults/empties by default to cut information load.
const compactSpecOn = ref(true)
const compactStatusOn = ref(true)

// Spec: user-declared fields only (last-applied / SSA ownership) + empty
// pruning.
const specResult = computed(() =>
  compactSpecOn.value
    ? compactSpec(props.object.spec, props.object.metadata)
    : { value: props.object.spec, filtered: false, source: "none" as const },
)
const specNodes = computed(() => buildFieldTree(specResult.value.value))
const specBadgeTitle = computed(() =>
  specResult.value.source === "managed-fields"
    ? "Showing only fields declared via server-side apply (managedFields). Defaults and system-managed fields are hidden."
    : "Showing only fields from the applied manifest (last-applied-configuration). API-server defaults are hidden.",
)

// Columns ConditionsTable renders above. Conditions are hidden from the field
// tree only when they carry nothing beyond these, so CRD-specific fields
// (observedGeneration, severity, lastUpdateTime, …) stay visible.
const CONDITION_TABLE_KEYS = new Set([
  "type",
  "status",
  "reason",
  "lastTransitionTime",
  "message",
])
const conditionsFullyShown = computed(() => {
  const status = props.object.status as { conditions?: unknown } | undefined | null
  const conditions = status?.conditions
  if (!Array.isArray(conditions)) return false
  return conditions.every(
    (cond) =>
      cond !== null &&
      typeof cond === "object" &&
      !Array.isArray(cond) &&
      Object.keys(cond as Record<string, unknown>).every((k) => CONDITION_TABLE_KEYS.has(k)),
  )
})
// Status has no notion of a manifest default; compact only prunes empties.
const statusSource = computed(() =>
  compactStatusOn.value ? pruneEmpty(props.object.status) : props.object.status,
)
const statusNodes = computed(() =>
  buildFieldTree(statusSource.value, {
    skipKeys: conditionsFullyShown.value ? ["conditions"] : [],
  }),
)
// A status consisting solely of ConditionsTable-covered conditions is fully
// rendered above; a raw-JSON duplicate below it would be noise.
const showStatusSection = computed(
  () => statusJson.value !== "" && !(conditionsFullyShown.value && statusNodes.value.length === 0),
)
</script>

<template>
  <div class="space-y-4">
    <MetadataCard :object="object" />

    <section
      v-if="detailNodes.length > 0"
      class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
    >
      <h3 class="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">Details</h3>
      <ObjectFieldTree :nodes="detailNodes" :namespace="object.metadata?.namespace" />
    </section>

    <RelatedResourcesCard :object="object" />
    <ConditionsTable :object="object" />
    <SecretDataPanel v-if="isSecret" :object="object" />
    <ConfigMapDataPanel v-if="isConfigMap" :object="object" />
    <NodePodsCard v-if="isNode" :object="object" />

    <section
      v-if="specJson !== ''"
      class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
    >
      <div class="mb-2 flex items-center gap-2">
        <h3 class="text-sm font-semibold uppercase tracking-wide text-slate-400">Spec</h3>
        <span
          v-if="!rawSpec && compactSpecOn && specResult.filtered"
          class="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400"
          :title="specBadgeTitle"
        >
          user-set
        </span>
        <div class="ml-auto flex items-center gap-3">
          <button
            v-if="specNodes.length > 0 && !rawSpec"
            type="button"
            class="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            title="Toggle hiding of defaults / system-managed / empty fields"
            @click="compactSpecOn = !compactSpecOn"
          >
            {{ compactSpecOn ? "full" : "compact" }}
          </button>
          <button
            v-if="specNodes.length > 0"
            type="button"
            class="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            @click="rawSpec = !rawSpec"
          >
            {{ rawSpec ? "tree" : "raw" }}
          </button>
        </div>
      </div>
      <ObjectFieldTree
        v-if="specNodes.length > 0 && !rawSpec"
        :nodes="specNodes"
        :namespace="object.metadata?.namespace"
      />
      <pre
        v-else
        class="max-h-96 overflow-auto rounded bg-slate-50 p-3 font-mono text-xs dark:bg-slate-800"
      >{{ specJson }}</pre>
    </section>

    <section
      v-if="showStatusSection"
      class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
    >
      <div class="mb-2 flex items-center gap-2">
        <h3 class="text-sm font-semibold uppercase tracking-wide text-slate-400">Status</h3>
        <div class="ml-auto flex items-center gap-3">
          <button
            v-if="statusNodes.length > 0 && !rawStatus"
            type="button"
            class="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            title="Toggle hiding of empty fields"
            @click="compactStatusOn = !compactStatusOn"
          >
            {{ compactStatusOn ? "full" : "compact" }}
          </button>
          <button
            v-if="statusNodes.length > 0"
            type="button"
            class="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            @click="rawStatus = !rawStatus"
          >
            {{ rawStatus ? "tree" : "raw" }}
          </button>
        </div>
      </div>
      <ObjectFieldTree
        v-if="statusNodes.length > 0 && !rawStatus"
        :nodes="statusNodes"
        :namespace="object.metadata?.namespace"
      />
      <pre
        v-else
        class="max-h-96 overflow-auto rounded bg-slate-50 p-3 font-mono text-xs dark:bg-slate-800"
      >{{ statusJson }}</pre>
    </section>

    <EventsCard :object="object" />
  </div>
</template>
