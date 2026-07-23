<script setup lang="ts">
import { computed, ref, watch } from "vue"

import { messageFromError } from "@/api/http"
import { deleteObject } from "@/api/k8s"
import type { ResourceRef } from "@/api/types"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseDialog from "@/components/ui/BaseDialog.vue"
import { useToastStore } from "@/stores/toasts"

const props = defineProps<{
  resourceRef: ResourceRef
  namespace: string | undefined
  name: string
}>()
const open = defineModel<boolean>("open", { required: true })
const emit = defineEmits<{ deleted: [] }>()

const toasts = useToastStore()
const confirmation = ref("")
const busy = ref(false)
const errorText = ref<string | null>(null)

watch(open, (isOpen) => {
  if (isOpen) {
    confirmation.value = ""
    errorText.value = null
  }
})

const canDelete = computed(() => confirmation.value === props.name)

async function run(): Promise<void> {
  if (!canDelete.value) return
  busy.value = true
  errorText.value = null
  try {
    await deleteObject(props.resourceRef, props.namespace, props.name)
    toasts.push("success", `Deleted ${props.name}.`)
    open.value = false
    emit("deleted")
  } catch (e) {
    errorText.value = messageFromError(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <BaseDialog v-model:open="open" title="Delete resource">
    <p class="text-sm text-slate-600 dark:text-slate-300">
      This permanently deletes
      <strong>{{ name }}</strong>
      <template v-if="namespace !== undefined"> in namespace <strong>{{ namespace }}</strong></template>.
      Type the resource name to confirm.
    </p>
    <input
      v-model="confirmation"
      type="text"
      :placeholder="name"
      spellcheck="false"
      autocomplete="off"
      class="mt-3 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm dark:border-slate-600 dark:bg-slate-800"
    />
    <p v-if="errorText !== null" class="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      {{ errorText }}
    </p>
    <template #footer>
      <BaseButton :disabled="busy" @click="open = false">Cancel</BaseButton>
      <BaseButton variant="danger" :disabled="!canDelete || busy" @click="run">Delete</BaseButton>
    </template>
  </BaseDialog>
</template>
