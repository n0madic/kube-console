<script setup lang="ts">
import { defineAsyncComponent, ref, watch } from "vue"

import { messageFromError } from "@/api/http"
import { serverSideApply } from "@/api/k8s"
import type { DiscoveryResource } from "@/api/types"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseDialog from "@/components/ui/BaseDialog.vue"
import { useToastStore } from "@/stores/toasts"
import { parseManifest } from "@/utils/yamlView"

// Lazy: load the CodeMirror chunk only when the create dialog opens.
const CodeMirrorEditor = defineAsyncComponent(() => import("./CodeMirrorEditor.vue"))

const props = defineProps<{
  resource: DiscoveryResource
  namespace: string
}>()
const open = defineModel<boolean>("open", { required: true })
const emit = defineEmits<{ created: [] }>()

const toasts = useToastStore()
const yamlText = ref("")
const busy = ref(false)
const errorText = ref<string | null>(null)

function template(): string {
  const apiVersion = props.resource.group === "" ? props.resource.version : `${props.resource.group}/${props.resource.version}`
  const lines = [`apiVersion: ${apiVersion}`, `kind: ${props.resource.kind}`, "metadata:", "  name: "]
  if (props.resource.namespaced) {
    lines.push(`  namespace: ${props.namespace !== "" ? props.namespace : "default"}`)
  }
  return lines.join("\n") + "\n"
}

watch(open, (isOpen) => {
  if (isOpen) {
    yamlText.value = template()
    errorText.value = null
  }
})

async function run(dryRun: boolean): Promise<void> {
  busy.value = true
  errorText.value = null
  try {
    const manifest = parseManifest(yamlText.value)
    const ref = {
      group: props.resource.group,
      version: props.resource.version,
      resource: props.resource.resource,
    }
    const namespace = props.resource.namespaced
      ? (manifest.namespace ?? (props.namespace !== "" ? props.namespace : "default"))
      : undefined
    await serverSideApply(ref, namespace, manifest.name, yamlText.value, { dryRun })
    if (dryRun) {
      toasts.push("success", "Dry run succeeded: the manifest is valid.")
    } else {
      toasts.push("success", `Created ${manifest.name}.`)
      open.value = false
      emit("created")
    }
  } catch (e) {
    errorText.value = messageFromError(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <BaseDialog v-model:open="open" :title="`Create ${resource.kind}`" wide>
    <div class="h-[55vh]">
      <CodeMirrorEditor v-model="yamlText" />
    </div>
    <p v-if="errorText !== null" class="mt-3 whitespace-pre-wrap rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      {{ errorText }}
    </p>
    <template #footer>
      <BaseButton :disabled="busy" @click="open = false">Cancel</BaseButton>
      <BaseButton :disabled="busy" @click="run(true)">Dry run</BaseButton>
      <BaseButton variant="primary" :disabled="busy" @click="run(false)">Create</BaseButton>
    </template>
  </BaseDialog>
</template>
