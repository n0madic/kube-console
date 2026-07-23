<script setup lang="ts">
// One dialog for every kind-specific action: it confirms, performs the
// targeted PATCH/POST itself and reports the outcome, like DeleteConfirmDialog.
// Denials arrive as the native Kubernetes 403 and stay in the dialog.

import { computed, ref, watch } from "vue"

import { messageFromError } from "@/api/http"
import { createObject, patchObject } from "@/api/k8s"
import type { K8sObject, ResourceRef } from "@/api/types"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseDialog from "@/components/ui/BaseDialog.vue"
import { useToastStore } from "@/stores/toasts"
import {
  currentReplicas,
  defaultManualJobName,
  manualJobFromCronJob,
  replicasPatch,
  restartPatch,
  suspendPatch,
  unschedulablePatch,
  type ResourceAction,
} from "@/utils/resourceActions"

const props = defineProps<{
  action: ResourceAction | null
  object: K8sObject
  resourceRef: ResourceRef
}>()
const open = defineModel<boolean>("open", { required: true })
const emit = defineEmits<{ done: [] }>()

const JOBS_REF: ResourceRef = { group: "batch", version: "v1", resource: "jobs" }

const toasts = useToastStore()
const busy = ref(false)
const errorText = ref<string | null>(null)
const replicas = ref(0)
const jobName = ref("")

const name = computed(() => props.object.metadata?.name ?? "")
const namespace = computed(() => props.object.metadata?.namespace)

watch(open, (isOpen) => {
  if (!isOpen) return
  errorText.value = null
  replicas.value = currentReplicas(props.object)
  jobName.value = defaultManualJobName(name.value, new Date())
})

/** Stepper for the replica input; a cleared field counts as 0, never negative. */
function step(delta: number): void {
  const base = Number.isInteger(replicas.value) ? replicas.value : 0
  replicas.value = Math.max(0, base + delta)
}

const canRun = computed(() => {
  if (props.action === null) return false
  if (props.action.id === "scale") return Number.isInteger(replicas.value) && replicas.value >= 0
  if (props.action.id === "trigger") return jobName.value !== ""
  return true
})

async function perform(action: ResourceAction): Promise<string> {
  switch (action.id) {
    case "scale":
      await patchObject(props.resourceRef, namespace.value, name.value, replicasPatch(replicas.value), {
        subresource: "scale",
      })
      return `Scaled ${name.value} to ${replicas.value}.`
    case "restart":
      await patchObject(props.resourceRef, namespace.value, name.value, restartPatch(new Date()), {
        type: "strategic",
      })
      return `Restart of ${name.value} triggered.`
    case "trigger":
      await createObject(JOBS_REF, namespace.value, manualJobFromCronJob(props.object, jobName.value))
      return `Created Job ${jobName.value}.`
    case "suspend":
    case "resume":
      await patchObject(
        props.resourceRef,
        namespace.value,
        name.value,
        suspendPatch(action.id === "suspend"),
      )
      return action.id === "suspend" ? `Suspended ${name.value}.` : `Resumed ${name.value}.`
    case "cordon":
    case "uncordon":
      await patchObject(
        props.resourceRef,
        namespace.value,
        name.value,
        unschedulablePatch(action.id === "cordon"),
      )
      return action.id === "cordon" ? `Cordoned ${name.value}.` : `Uncordoned ${name.value}.`
  }
}

async function run(): Promise<void> {
  const action = props.action
  if (action === null || !canRun.value) return
  busy.value = true
  errorText.value = null
  try {
    const message = await perform(action)
    toasts.push("success", message)
    open.value = false
    emit("done")
  } catch (e) {
    errorText.value = messageFromError(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <BaseDialog v-model:open="open" :title="action?.label ?? ''">
    <template v-if="action !== null">
      <!-- The target, spelled out: kind + name (+ namespace) before the effect,
           so it is unmistakable which object the action hits. -->
      <p
        class="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md bg-slate-100 px-3 py-2 dark:bg-slate-800"
      >
        <span class="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {{ object.kind }}
        </span>
        <strong class="font-mono text-sm text-slate-900 dark:text-slate-100">{{ name }}</strong>
        <span v-if="namespace !== undefined" class="text-xs text-slate-500 dark:text-slate-400">
          in
          <span class="font-mono text-slate-600 dark:text-slate-300">{{ namespace }}</span>
          namespace
        </span>
      </p>
      <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">{{ action.confirm }}</p>

      <label v-if="action.id === 'scale'" class="mt-3 flex items-center gap-3">
        <span class="text-sm text-slate-500 dark:text-slate-400">
          Replicas (currently {{ currentReplicas(object) }})
        </span>
        <!-- Own -/+ stepper: the native number spinner is tiny, mouse-only and
             renders in the browser's own style, which clashes with the dialog. -->
        <span
          class="inline-flex items-stretch overflow-hidden rounded-md border border-slate-300 dark:border-slate-600"
        >
          <button
            type="button"
            aria-label="Decrease replicas"
            :disabled="replicas <= 0"
            class="px-3 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-700"
            @click="step(-1)"
          >
            −
          </button>
          <input
            v-model.number="replicas"
            type="number"
            min="0"
            step="1"
            inputmode="numeric"
            class="w-16 border-x border-slate-300 bg-white px-2 py-2 text-center font-mono text-sm [appearance:textfield] dark:border-slate-600 dark:bg-slate-800 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <button
            type="button"
            aria-label="Increase replicas"
            class="px-3 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
            @click="step(1)"
          >
            +
          </button>
        </span>
      </label>

      <label v-else-if="action.id === 'trigger'" class="mt-3 block">
        <span class="text-sm text-slate-500 dark:text-slate-400">Job name</span>
        <input
          v-model="jobName"
          type="text"
          spellcheck="false"
          autocomplete="off"
          class="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm dark:border-slate-600 dark:bg-slate-800"
        />
      </label>

      <p
        v-if="errorText !== null"
        class="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
      >
        {{ errorText }}
      </p>
    </template>
    <template #footer>
      <BaseButton :disabled="busy" @click="open = false">Cancel</BaseButton>
      <BaseButton
        :variant="action?.variant === 'danger' ? 'danger' : 'primary'"
        :disabled="!canRun || busy"
        @click="run"
      >
        {{ action?.label ?? "" }}
      </BaseButton>
    </template>
  </BaseDialog>
</template>
