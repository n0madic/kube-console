<script setup lang="ts">
// The Container picker shared by the Pod Logs and Terminal tabs: same list,
// same grouping, same wording — the tabs differ only in what they do with the
// choice. Selecting the initial value stays with them (`defaultContainerName`),
// since Logs restarts its stream on every change and must not fire on mount.

import { computed } from "vue"

import type { K8sObject } from "@/api/types"
import type { ContainerKind } from "@/utils/podHelpers"
import { podContainers } from "@/utils/podHelpers"

// `title` is a declared prop, not a fallthrough attribute: the component has
// its own reason to explain (below), so it must decide which one wins rather
// than have the caller's land on the label unconditionally.
const props = withDefaults(
  defineProps<{ object: K8sObject; disabled?: boolean; title?: string }>(),
  { disabled: false, title: undefined },
)

const model = defineModel<string>({ required: true })

const GROUP_LABELS: Record<ContainerKind, string> = {
  container: "Containers",
  ephemeral: "Ephemeral containers",
  init: "Init containers",
}

const containers = computed(() => podContainers(props.object))

// A pod with exactly one container has nothing to pick — a popup that opens
// onto its own current value is not a choice — so the picker is locked. The
// control itself stays a <select>: the toolbar keeps one shape, and the name
// still reads as what logs and exec are bound to.
const sole = computed(() => containers.value.length === 1)

const locked = computed(() => props.disabled || sole.value)

// Dimmed *and* unclickable is ambiguous on its own; the two reasons differ in
// what the user can do about them, so each says so. The caller's title wins:
// a running exec session is the more specific state of the two.
const hint = computed(() =>
  props.title ?? (sole.value ? "The only container in this pod" : undefined),
)

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
  <!-- Locked has to *look* locked: the Terminal tab holds this picker for the
       lifetime of an exec session, and an unstyled select that ignores clicks
       just reads as a click that did nothing. -->
  <label
    class="flex items-center gap-1.5"
    :class="locked ? 'cursor-not-allowed opacity-60' : ''"
    :title="hint"
  >
    <span class="text-slate-500 dark:text-slate-400">Container</span>
    <select
      v-model="model"
      :disabled="locked"
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
