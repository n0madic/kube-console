<script setup lang="ts">
// The Pod picker at the front of a workload's Logs toolbar: which of the
// owner's pods the stream (and the Container picker beside it) is bound to.
// Its own component rather than lines in WorkloadLogsTab because it has to
// render *without* PodLogsTab — before the first pod GET answers and after it
// fails — and it mirrors ContainerSelect's rules: one pod locks the control
// (a popup that opens onto its own current value is not a choice) and says
// why in the title, but the control keeps its shape in the toolbar.

import { computed } from "vue"

import BaseSelect from "@/components/ui/BaseSelect.vue"
import type { PodChoice } from "@/utils/ownedPods"

const props = defineProps<{ choices: PodChoice[]; truncated: boolean }>()

const model = defineModel<string>({ required: true })

const sole = computed(() => props.choices.length === 1)
const hint = computed(() => (sole.value ? "The only pod" : undefined))

// "name · Status" — the status is what tells a Running pod from the
// Completed or CrashLoopBackOff one beside it; absent (the List→Table
// fallback prints no Status column) the name stands alone.
function optionText(choice: PodChoice): string {
  return choice.status === "" ? choice.name : `${choice.name} · ${choice.status}`
}

// The control's own title: the full text of the current pick, since the
// control is width-capped below and a generated pod name plus its status
// does not fit — and, when locked, the reason too, because the select is
// what the pointer lands on, not the caption carrying `hint`.
const selectTitle = computed(() => {
  const current = props.choices.find((c) => c.name === model.value)
  const text = current === undefined ? undefined : optionText(current)
  if (hint.value === undefined) return text
  return text === undefined ? hint.value : `${text} — ${hint.value.toLowerCase()}`
})
</script>

<template>
  <label
    class="flex items-center gap-1.5"
    :class="sole ? 'cursor-not-allowed opacity-60' : ''"
    :title="hint"
  >
    <span class="text-slate-500 dark:text-slate-400">Pod</span>
    <!-- Capped and ellipsized: a native select is as wide as its longest
         option, and "<name>-<hash>-<id> · CrashLoopBackOff" ran to ~330px —
         enough to push the log toolbar's search group onto a second line on
         an ordinary laptop width. The popup still shows every option whole. -->
    <BaseSelect
      v-model="model"
      :disabled="sole"
      class="max-w-[14rem] truncate"
      :title="selectTitle"
    >
      <option v-for="choice in choices" :key="choice.name" :value="choice.name">
        {{ optionText(choice) }}
      </option>
      <!-- Never selectable; the value only has to match no real pod, and
           DNS-1123 names cannot contain underscores (as NamespaceSelector). -->
      <option v-if="truncated" disabled value="__truncated__">… more pods not listed</option>
    </BaseSelect>
  </label>
</template>
