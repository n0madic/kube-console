<script setup lang="ts">
// The Logs tab of a pod owner (Deployment, ReplicaSet, StatefulSet, DaemonSet,
// Job, Service): PodLogsTab, unchanged, streaming whichever of the owner's
// pods is picked in the toolbar. The pods come from the page's one resolution
// (useOwnedPods); this tab only picks one and fetches it in full — Table rows
// carry metadata alone, and ContainerSelect/defaultContainerName need the
// spec. Handing PodLogsTab a different pod object is what restarts the
// stream: it watches the uid.

import { computed, ref, shallowRef, watch } from "vue"

import { messageFromError } from "@/api/http"
import { getObject } from "@/api/k8s"
import type { OwnedPods } from "@/api/ownedPods"
import type { K8sObject } from "@/api/types"
import { PODS_REF, defaultPodName, podChoices } from "@/utils/ownedPods"

import PodLogsTab from "./PodLogsTab.vue"
import WorkloadPodSelect from "./WorkloadPodSelect.vue"

const props = defineProps<{ object: K8sObject; ownedPods: OwnedPods }>()

const choices = computed(() => podChoices(props.ownedPods.pods))
const selectedName = ref("")
const pod = shallowRef<K8sObject | null>(null)
const loading = ref(false)
const errorText = ref<string | null>(null)

// Guards against a stale in-flight response overwriting a newer pick's data.
let loadId = 0

async function loadPod(): Promise<void> {
  const id = ++loadId
  const name = selectedName.value
  if (name === "") {
    pod.value = null
    errorText.value = null
    loading.value = false
    return
  }
  loading.value = true
  errorText.value = null
  try {
    const result = await getObject(PODS_REF, props.object.metadata?.namespace, name)
    if (id !== loadId) return
    pod.value = result
  } catch (e) {
    if (id !== loadId) return
    // The previous pod stays mounted with the error beside it — the same rule
    // as useResourceObject's loadedKey: nulling it would unmount PodLogsTab
    // and end the stream the user is reading over one failed GET.
    errorText.value = messageFromError(e)
  } finally {
    if (id === loadId) loading.value = false
  }
}

// The list changes only when the page hands over a new object (Refresh, apply,
// action). The pick survives by name when the pod is still there, else falls
// to the default — and a kept name is fetched again either way: a StatefulSet
// pod keeps its name across a recreation, and only a fresh object carries the
// new uid PodLogsTab restarts on. The user's pick goes through `pick` rather
// than a watch on the name, so neither path can issue the GET twice.
watch(
  choices,
  (list) => {
    if (!list.some((c) => c.name === selectedName.value)) {
      selectedName.value = defaultPodName(list)
    }
    void loadPod()
  },
  { immediate: true },
)

function pick(name: string): void {
  if (name === selectedName.value) return
  selectedName.value = name
  void loadPod()
}

// The picker is rendered in two places (inside PodLogsTab's toolbar once a
// pod is loaded, on its own before that), so its bindings live in one object.
const pickerProps = computed(() => ({
  modelValue: selectedName.value,
  choices: choices.value,
  truncated: props.ownedPods.truncated,
}))
</script>

<template>
  <!-- One root element, not a fragment: the page passes `class="h-full"`. -->
  <div class="flex h-full min-h-0 flex-col gap-2">
    <!-- Above the toolbar, like the page's own error banner sits above the
         tabs: the toolbar belongs to PodLogsTab, and the stream it shows is
         still the previous pod's. -->
    <p
      v-if="errorText !== null"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
    >
      Cannot load pod {{ selectedName }}: {{ errorText }}
    </p>
    <PodLogsTab v-if="pod !== null" :object="pod" class="min-h-0 flex-1">
      <template #leading>
        <WorkloadPodSelect v-bind="pickerProps" @update:model-value="pick" />
      </template>
    </PodLogsTab>
    <!-- Before the first pod answers (or after it fails), the picker is still
         the way out — a Loading line alone would leave nothing to change. -->
    <div v-else class="flex flex-wrap items-center gap-2 text-sm">
      <WorkloadPodSelect v-bind="pickerProps" @update:model-value="pick" />
      <span v-if="loading" class="text-xs text-slate-400">Loading…</span>
    </div>
  </div>
</template>
