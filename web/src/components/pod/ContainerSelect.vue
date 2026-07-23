<script setup lang="ts">
// The Container picker shared by the Pod Logs and Terminal tabs: same list,
// same grouping, same wording — the tabs differ only in what they do with the
// choice. Selecting the initial value stays with them (`defaultContainerName`),
// since Logs restarts its stream on every change and must not fire on mount.

import { computed } from "vue"

import type { K8sObject } from "@/api/types"
import type { ContainerKind } from "@/utils/podHelpers"
import { podContainers } from "@/utils/podHelpers"

const props = withDefaults(defineProps<{ object: K8sObject; disabled?: boolean }>(), {
  disabled: false,
})

const model = defineModel<string>({ required: true })

const GROUP_LABELS: Record<ContainerKind, string> = {
  container: "Containers",
  ephemeral: "Ephemeral containers",
  init: "Init containers",
}

const containers = computed(() => podContainers(props.object))

// Grouping only pays off when more than one kind is present — a plain app pod
// would otherwise get a lone "Containers" heading over its single option.
const groups = computed(() =>
  (Object.keys(GROUP_LABELS) as ContainerKind[])
    .map((kind) => ({
      kind,
      label: GROUP_LABELS[kind],
      names: containers.value.filter((c) => c.kind === kind).map((c) => c.name),
    }))
    .filter((group) => group.names.length > 0),
)
</script>

<template>
  <!-- Disabled has to *look* disabled: the Terminal tab locks the picker for
       the lifetime of an exec session, and an unstyled locked select just
       reads as a click that did nothing. -->
  <label class="flex items-center gap-1.5" :class="disabled ? 'cursor-not-allowed opacity-60' : ''">
    <span class="text-slate-500 dark:text-slate-400">Container</span>
    <select
      v-model="model"
      :disabled="disabled"
      class="rounded-md border border-slate-300 bg-white px-2 py-1 disabled:cursor-not-allowed dark:border-slate-600 dark:bg-slate-800"
    >
      <template v-if="groups.length > 1">
        <optgroup v-for="group in groups" :key="group.kind" :label="group.label">
          <option v-for="name in group.names" :key="name" :value="name">{{ name }}</option>
        </optgroup>
      </template>
      <template v-else>
        <option v-for="c in containers" :key="c.name" :value="c.name">{{ c.name }}</option>
      </template>
    </select>
  </label>
</template>
