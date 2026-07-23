<script setup lang="ts">
// Secret data UX: keys are listed, values stay masked until the user clicks
// the eye button — that click is the explicit reveal action. Decoded values
// are never persisted, never logged and never auto-copied anywhere.

import { computed } from "vue"

import type { K8sObject } from "@/api/types"
import ExpandableValue from "@/components/ui/ExpandableValue.vue"
import RevealButton from "@/components/ui/RevealButton.vue"
import { useReveal } from "@/composables/useReveal"
import { decodeBase64Utf8 } from "@/utils/base64"

const props = defineProps<{ object: K8sObject }>()

// The detail page reuses this component across Secrets, so reset the reveal
// state on object change — otherwise a key revealed on one Secret would
// auto-decode a same-named key on the next Secret without an explicit click.
const { isRevealed, toggle } = useReveal<string>((key) => key, () => props.object.metadata?.uid)

const entries = computed(() => Object.entries(props.object.data ?? {}))
</script>

<template>
  <section class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
    <h3 class="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-400">Secret data</h3>
    <p class="mb-3 text-xs text-slate-400">
      Values are masked. The eye button decodes the value in this browser tab only.
    </p>
    <p v-if="entries.length === 0" class="text-sm text-slate-400">No data keys.</p>
    <ul class="space-y-2">
      <li v-for="[key, value] in entries" :key="key" class="rounded-md border border-slate-100 p-2 dark:border-slate-800">
        <div class="flex items-center justify-between gap-2">
          <span class="font-mono text-sm font-medium">{{ key }}</span>
          <RevealButton :revealed="isRevealed(key)" @toggle="toggle(key)" />
        </div>
        <ExpandableValue
          v-if="isRevealed(key)"
          :value="decodeBase64Utf8(value)"
          class="mt-2"
          collapsed-height-class="max-h-48"
        />
        <p v-else class="mt-1 font-mono text-xs text-slate-400">••••••••</p>
      </li>
    </ul>
  </section>
</template>
