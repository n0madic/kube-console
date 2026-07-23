<script setup lang="ts">
import { defineAsyncComponent, ref, watch } from "vue"

import { ApiError, messageFromError } from "@/api/http"
import { serverSideApply } from "@/api/k8s"
import type { K8sObject, ResourceRef } from "@/api/types"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseDialog from "@/components/ui/BaseDialog.vue"
import { useToastStore } from "@/stores/toasts"
import { toEditableYaml } from "@/utils/yamlView"

// Lazy: load the CodeMirror chunk only when the edit dialog opens.
const CodeMirrorEditor = defineAsyncComponent(() => import("./CodeMirrorEditor.vue"))

const props = defineProps<{
  resourceRef: ResourceRef
  object: K8sObject
}>()
const open = defineModel<boolean>("open", { required: true })
const emit = defineEmits<{ applied: [] }>()

const toasts = useToastStore()
const yamlText = ref("")
const busy = ref(false)
const errorText = ref<string | null>(null)
const conflictText = ref<string | null>(null)

watch(open, (isOpen) => {
  if (isOpen) {
    yamlText.value = toEditableYaml(props.object)
    errorText.value = null
    conflictText.value = null
  }
})

function applyError(e: unknown): void {
  if (e instanceof ApiError && e.status === 409) {
    // Show the native Kubernetes conflict response (field managers etc.).
    const causes = e.k8sStatus?.details?.causes
      ?.map((c) => c.message ?? c.field ?? "")
      .filter((m) => m !== "")
    conflictText.value = [e.message, ...(causes ?? [])].join("\n")
  } else {
    errorText.value = messageFromError(e)
  }
}

async function run(dryRun: boolean): Promise<void> {
  const target = props.object.metadata
  if (target?.name === undefined) return
  busy.value = true
  errorText.value = null
  conflictText.value = null
  try {
    await serverSideApply(props.resourceRef, target.namespace, target.name, yamlText.value, {
      dryRun,
    })
    if (dryRun) {
      toasts.push("success", "Dry run succeeded: the manifest is valid.")
    } else {
      toasts.push("success", `Applied ${target.name}.`)
      open.value = false
      emit("applied")
    }
  } catch (e) {
    applyError(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <BaseDialog v-model:open="open" title="Edit YAML (server-side apply)" wide>
    <div class="h-[55vh]">
      <CodeMirrorEditor v-model="yamlText" />
    </div>

    <p v-if="errorText !== null" class="mt-3 whitespace-pre-wrap rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      {{ errorText }}
    </p>
    <div v-if="conflictText !== null" class="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
      <p class="font-semibold">Field conflict (409) — another field manager owns these fields:</p>
      <pre class="mt-1 whitespace-pre-wrap font-mono text-xs">{{ conflictText }}</pre>
    </div>

    <template #footer>
      <BaseButton :disabled="busy" @click="open = false">Cancel</BaseButton>
      <BaseButton :disabled="busy" @click="run(true)">Dry run</BaseButton>
      <BaseButton variant="primary" :disabled="busy" @click="run(false)">Apply</BaseButton>
    </template>
  </BaseDialog>
</template>
