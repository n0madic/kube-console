<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue"

import type { K8sObject } from "@/api/types"
import { toYaml } from "@/utils/yamlView"

// Lazy: the CodeMirror chunk (~150 kB gz) loads only when the YAML tab renders,
// not on every detail-page view.
const CodeMirrorEditor = defineAsyncComponent(() => import("./CodeMirrorEditor.vue"))

const props = defineProps<{ object: K8sObject; hideManagedFields?: boolean }>()

const showManaged = ref(false)

const yamlText = computed(() => {
  if (showManaged.value) return toYaml(props.object)
  const clone = JSON.parse(JSON.stringify(props.object)) as K8sObject
  if (clone.metadata !== undefined) delete clone.metadata.managedFields
  return toYaml(clone)
})

// CodeMirrorEditor uses v-model; mirror the computed into a local ref.
const doc = ref(yamlText.value)
watch(yamlText, (text) => {
  doc.value = text
})
</script>

<template>
  <div class="flex h-full flex-col gap-2">
    <label class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <input v-model="showManaged" type="checkbox" />
      Show managedFields
    </label>
    <div class="min-h-0 flex-1">
      <CodeMirrorEditor v-model="doc" readonly />
    </div>
  </div>
</template>
