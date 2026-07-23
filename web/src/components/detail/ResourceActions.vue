<script setup lang="ts">
// Kind-specific day-2 buttons in the detail header (scale, rollout restart,
// manual CronJob run, suspend/resume, cordon/uncordon). Which ones appear comes
// from the pure registry in utils/resourceActions; the shared dialog runs them.
// No RBAC gating: a denied action returns the native Kubernetes 403 in the
// dialog, same as Edit YAML and Delete.

import { computed, ref } from "vue"

import type { K8sObject, ResourceRef } from "@/api/types"
import ResourceActionDialog from "@/components/detail/ResourceActionDialog.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import { actionsFor, type ResourceAction } from "@/utils/resourceActions"

const props = defineProps<{ object: K8sObject; resourceRef: ResourceRef }>()
const emit = defineEmits<{ changed: [] }>()

const actions = computed(() => actionsFor(props.object))

const current = ref<ResourceAction | null>(null)
const dialogOpen = ref(false)

function start(action: ResourceAction): void {
  current.value = action
  dialogOpen.value = true
}
</script>

<template>
  <template v-if="actions.length > 0">
    <!-- Header buttons stay neutral (Delete is the only red one there); the
         action's variant colors the confirm button inside the dialog. -->
    <BaseButton v-for="action in actions" :key="action.id" @click="start(action)">
      {{ action.label }}
    </BaseButton>
    <ResourceActionDialog
      v-model:open="dialogOpen"
      :action="current"
      :object="object"
      :resource-ref="resourceRef"
      @done="emit('changed')"
    />
  </template>
</template>
