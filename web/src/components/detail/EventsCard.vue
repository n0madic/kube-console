<script setup lang="ts">
// Events referencing this object, as a compact table on the Overview page
// (kubectl describe puts them last, so does this card). The section renders
// only when there is at least one event — an empty object shows nothing.
// A load error is surfaced instead of being swallowed.

import { computed, onMounted, ref, watch } from "vue"

import { messageFromError } from "@/api/http"
import { eventsFor } from "@/api/k8s"
import type { K8sObject } from "@/api/types"
import {
  eventRowClass,
  sortByLastSeenDesc,
  toEventRow,
  type EventRow,
} from "@/utils/eventHelpers"
import { statusTextClass } from "@/utils/statusColors"
import { formatAge } from "@/utils/units"

const props = defineProps<{ object: K8sObject }>()

const rows = ref<EventRow[]>([])
const loading = ref(false)
const errorText = ref<string | null>(null)

// Guards against a stale in-flight response overwriting a newer object's data.
let loadId = 0

async function load(): Promise<void> {
  const id = ++loadId
  loading.value = true
  errorText.value = null
  // Drop the previous object's events immediately: the detail page reuses this
  // component across resources, so without clearing, the card would show the
  // old object's events until the new fetch resolves (or indefinitely if the
  // new object has none). Matches RelatedResourcesCard/NodePodsCard.
  rows.value = []
  try {
    const list = await eventsFor(props.object)
    if (id !== loadId) return
    rows.value = sortByLastSeenDesc((list.items ?? []).map(toEventRow))
  } catch (e) {
    if (id !== loadId) return
    errorText.value = messageFromError(e)
  } finally {
    if (id === loadId) loading.value = false
  }
}

onMounted(load)
// The detail page reuses this component across resources, so reload when the
// object changes — otherwise it keeps showing the previous object's events.
// Keyed on identity rather than uid so an explicit refresh of the same object
// (Refresh button, YAML apply, kind-specific action) also picks up new events.
watch(() => props.object, load)

// Show the section only when there is something to show: at least one event or
// an error. Loading with no prior data stays hidden (no empty "Events" flash).
const hasContent = computed(() => rows.value.length > 0 || errorText.value !== null)
</script>

<template>
  <section
    v-if="hasContent"
    class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
  >
    <h3 class="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
      Events<span v-if="rows.length > 0" class="ml-1 font-normal normal-case">
        ({{ rows.length }})</span>
    </h3>
    <p v-if="errorText !== null" class="text-sm text-slate-400">
      Cannot load events: {{ errorText }}
    </p>
    <div v-else class="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table class="w-full text-sm">
        <thead class="bg-slate-100 text-left text-xs uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          <tr>
            <th class="px-3 py-2">Type</th>
            <th class="px-3 py-2">Reason</th>
            <th class="px-3 py-2">Age</th>
            <th class="px-3 py-2">From</th>
            <th class="px-3 py-2">Count</th>
            <th class="px-3 py-2">Message</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, idx) in rows"
            :key="row.uid || idx"
            class="border-t border-slate-100 dark:border-slate-800"
            :class="eventRowClass(row)"
          >
            <td
              class="px-3 py-1.5"
              :class="row.type === 'Warning' ? 'text-amber-600 dark:text-amber-400' : ''"
            >
              {{ row.type }}
            </td>
            <td class="px-3 py-1.5" :class="statusTextClass(row.reason) ?? ''">{{ row.reason }}</td>
            <td class="whitespace-nowrap px-3 py-1.5">{{ formatAge(row.lastSeen) }}</td>
            <td class="px-3 py-1.5">{{ row.source }}</td>
            <td class="px-3 py-1.5">{{ row.count }}</td>
            <td class="break-words px-3 py-1.5 text-slate-600 dark:text-slate-300">{{ row.message }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
