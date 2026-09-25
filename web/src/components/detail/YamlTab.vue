<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch, watchEffect } from "vue"

import { ApiError, messageFromError } from "@/api/http"
import { serverSideApply } from "@/api/k8s"
import type { K8sObject, ResourceRef } from "@/api/types"
import BaseButton from "@/components/ui/BaseButton.vue"
import { useToastStore } from "@/stores/toasts"
import { isSecret } from "@/utils/secrets"
import { encodeSecretYaml, toDecodedSecretYaml, toEditableYaml, toYaml } from "@/utils/yamlView"

// Lazy: the CodeMirror chunk (~110 kB gz) loads only when the YAML tab renders,
// not on every detail-page view.
const CodeMirrorEditor = defineAsyncComponent(() => import("./CodeMirrorEditor.vue"))

const props = defineProps<{ object: K8sObject; resourceRef: ResourceRef }>()
const emit = defineEmits<{ applied: [] }>()

const toasts = useToastStore()

// Secrets can be edited with `data` decoded: values as plain text (binary ones
// as `!!binary`), re-encoded to base64 by Dry run/Apply. Off by default and
// never persisted — switching it on is the explicit reveal, as the eye button
// is in SecretDataPanel — and it dies with the tab, which is keyed per object.
const secret = computed(() => isSecret(props.object))
const decoded = ref(false)

function project(obj: K8sObject): string {
  return decoded.value ? toDecodedSecretYaml(obj) : toEditableYaml(obj)
}

// What is edited is the apply-ready projection: what is on screen is exactly
// what Apply sends (in decoded mode, once re-encoded).
const draft = ref(project(props.object))
// The text `draft` was seeded from: Cancel returns here, and dirtiness is
// measured against it rather than against `props.object` directly.
const baseline = ref(draft.value)
const dirty = computed(() => draft.value !== baseline.value)

// The read-only escape hatch: the whole object as the API returned it, status
// and managedFields included (the latter is what a 409 sends you looking for).
const showFull = ref(false)
const fullDoc = ref("")
watchEffect(() => {
  if (showFull.value) fullDoc.value = toYaml(props.object)
})

const busy = ref(false)
const errorText = ref<string | null>(null)
const conflictText = ref<string | null>(null)
const objectChanged = ref(false)

// All three buttons are gated alike. `showFull` matters: otherwise Apply would
// send a draft that is not on screen, and Cancel would destroy it out of sight.
const actionsDisabled = computed(() => busy.value || !dirty.value || showFull.value)

// Switching projection under an edit has no clean meaning (the draft is in the
// other encoding), so the mode changes only on a clean draft, like reseeding.
const decodeDisabled = computed(() => busy.value || dirty.value)
const decodeTitle = computed(() =>
  dirty.value
    ? "Apply or cancel your edits first."
    : "Edit data values as plain text; binary values stay base64, marked !!binary. " +
      "Dry run and Apply encode everything back to base64. Decoded values stay in this tab only.",
)

function setDecoded(on: boolean): void {
  decoded.value = on
  draft.value = baseline.value = project(props.object)
  objectChanged.value = false
}

watch(
  () => props.object,
  (obj) => {
    const next = project(obj)
    // Compare the *editable projection*, not object identity and not
    // resourceVersion: useResourceObject hands over a new object on every
    // refresh, and a status heartbeat moves resourceVersion without touching a
    // byte of what this tab edits. Any other criterion would raise "changed on
    // the server" on every Refresh click.
    if (next === baseline.value) return
    const wasDirty = draft.value !== baseline.value // read before shifting the baseline
    baseline.value = next // Cancel always returns to the fresh server text
    if (wasDirty) {
      objectChanged.value = true
    } else {
      draft.value = next
      objectChanged.value = false
    }
  },
)

// Editing again is the answer to a rejected apply or dry run, so the banner
// goes with the first keystroke: it describes the text that was sent, not the
// one now on screen. `run()` clears it too, for the case where the same text is
// sent twice.
watch(draft, () => {
  errorText.value = null
  conflictText.value = null
})

function cancel(): void {
  draft.value = baseline.value
  errorText.value = null
  conflictText.value = null
  objectChanged.value = false
}

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
  // The request targets the object this tab was opened on, not the name in the
  // draft: a renamed metadata.name is the apiserver's to reject, rather than
  // ours to silently apply to some other object.
  const target = props.object.metadata
  if (target?.name === undefined) return
  errorText.value = null
  conflictText.value = null
  let body = draft.value
  if (decoded.value) {
    try {
      body = encodeSecretYaml(body)
    } catch (e) {
      // A YAML syntax error or a non-string value: nothing was sent.
      errorText.value = e instanceof Error ? e.message : String(e)
      return
    }
  }
  busy.value = true
  try {
    await serverSideApply(props.resourceRef, target.namespace, target.name, body, { dryRun })
    if (dryRun) {
      toasts.push("success", "Dry run succeeded: the manifest is valid.")
    } else {
      toasts.push("success", `Applied ${target.name}.`)
      // Clear *before* the refresh lands: the object that arrives then reseeds
      // the editor silently through the watch above, leaving the text the
      // server normalized on screen.
      baseline.value = draft.value
      objectChanged.value = false
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
  <div class="flex h-full min-h-0 flex-col gap-2">
    <div class="flex flex-wrap items-center gap-3 text-sm">
      <label
        class="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"
        title="Show the object as the API returned it, status and managedFields included. Not editable."
      >
        <input v-model="showFull" type="checkbox" />
        Full object (read-only)
      </label>
      <label
        v-if="secret"
        class="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"
        :title="decodeTitle"
      >
        <input
          type="checkbox"
          :checked="decoded"
          :disabled="decodeDisabled"
          @change="setDecoded(($event.target as HTMLInputElement).checked)"
        />
        Decode base64
      </label>
      <span v-if="dirty" class="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</span>
      <div class="flex-1"></div>
      <BaseButton :disabled="actionsDisabled" @click="cancel">Cancel</BaseButton>
      <BaseButton :disabled="actionsDisabled" @click="run(true)">Dry run</BaseButton>
      <BaseButton variant="primary" :disabled="actionsDisabled" @click="run(false)">
        Apply
      </BaseButton>
    </div>

    <!-- Messages sit between the toolbar and the editor: next to the buttons
         that produced them, and out of reach of the fold on a 4000-line
         manifest. -->
    <p
      v-if="objectChanged && dirty"
      class="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:bg-blue-950 dark:text-blue-100"
    >
      This object changed on the server; your edits are kept. Cancel reloads the new version.
    </p>
    <p
      v-if="errorText !== null"
      class="whitespace-pre-wrap rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
    >
      {{ errorText }}
    </p>
    <div
      v-if="conflictText !== null"
      class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <p class="font-semibold">Field conflict (409) — another field manager owns these fields:</p>
      <pre class="mt-1 whitespace-pre-wrap font-mono text-xs">{{ conflictText }}</pre>
    </div>

    <div class="min-h-0 flex-1">
      <!-- Two instances rather than one reconfigured view: CodeMirrorEditor
           bakes EditorState.readOnly in at construction, and swapping the
           document on a single view would go through its model watch as a full
           text replacement — i.e. into the undo history, one Ctrl+Z away from
           replacing the draft with the full object. -->
      <CodeMirrorEditor v-if="showFull" v-model="fullDoc" readonly />
      <CodeMirrorEditor v-else v-model="draft" />
    </div>
  </div>
</template>
