<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"

import { apiFetch, messageFromError } from "@/api/http"
import { logsUrl } from "@/api/k8s"
import type { K8sObject } from "@/api/types"
import AppIcon from "@/components/ui/AppIcon.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import { MAX_LINES, useLogsStream } from "@/composables/useLogsStream"
import { saveBlob } from "@/utils/download"
import { defaultContainerName } from "@/utils/podHelpers"

import ContainerSelect from "./ContainerSelect.vue"
import LogViewer from "./LogViewer.vue"

const props = defineProps<{ object: K8sObject }>()

const container = ref("")
// "all" omits tailLines entirely: the log endpoint has no pagination, so
// reading from the container's start means asking for the whole thing at once.
const tailLines = ref<number | "all">(500)
const timestamps = ref(false)
const previous = ref(false)
const follow = ref(true)
// Rendering-only: never part of the stream URL, so toggling it must not restart.
const wrap = ref(false)

const stream = useLogsStream()

function currentUrl(): string | null {
  const meta = props.object.metadata
  if (meta?.namespace === undefined || meta.name === undefined) return null
  return logsUrl(meta.namespace, meta.name, {
    container: container.value,
    tailLines: tailLines.value === "all" ? undefined : tailLines.value,
    timestamps: timestamps.value,
    previous: previous.value,
    follow: follow.value,
  })
}

// URL the stream was last started with, so the option watcher can tell a real
// change from the echo of a change the mount / pod-change path already acted on.
let startedUrl: string | null = null

function restart(): void {
  const url = currentUrl()
  if (url === null) return
  startedUrl = url
  void stream.start(url)
}

const downloading = ref(false)
const downloadError = ref<string | null>(null)

const errors = computed(() =>
  [stream.error.value, downloadError.value].filter((m): m is string => m !== null),
)

// The escape hatch for a log too large to hold in the viewer: always the whole
// log, never followed, saved to a file instead of rendered.
async function download(): Promise<void> {
  const meta = props.object.metadata
  if (meta?.namespace === undefined || meta.name === undefined) return
  const url = logsUrl(meta.namespace, meta.name, {
    container: container.value,
    timestamps: timestamps.value,
    previous: previous.value,
  })
  downloading.value = true
  downloadError.value = null
  try {
    const resp = await apiFetch(url)
    const suffix = previous.value ? "-previous" : ""
    saveBlob(await resp.blob(), `${meta.name}_${container.value}${suffix}.log`)
  } catch (e) {
    downloadError.value = messageFromError(e, "Log download failed.")
  } finally {
    downloading.value = false
  }
}

function selectDefaultContainerAndRestart(): void {
  container.value = defaultContainerName(props.object)
  restart()
}

onMounted(selectDefaultContainerAndRestart)

// The detail page reuses this component across pod navigations, so an in-place
// pod change must reset the container and restart the stream — otherwise it
// keeps streaming the previous pod's logs.
watch(() => props.object.metadata?.uid, selectDefaultContainerAndRestart)

// Skip the echo: mounting (and switching pods) assigns the container and starts
// the stream in one synchronous step, and this watcher would then fire for the
// same URL — opening a second request to the apiserver only to abort the first.
watch([container, tailLines, timestamps, previous, follow], () => {
  if (currentUrl() === startedUrl) return
  restart()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-2">
    <div class="flex flex-wrap items-center gap-3 text-sm">
      <ContainerSelect v-model="container" :object="object" />
      <label class="flex items-center gap-1.5">
        <span class="text-slate-500 dark:text-slate-400">Tail</span>
        <BaseSelect v-model="tailLines">
          <option :value="100">100</option>
          <option :value="500">500</option>
          <option :value="2000">2000</option>
          <option :value="10000">10000</option>
          <option value="all">All</option>
        </BaseSelect>
      </label>
      <label class="flex items-center gap-1.5">
        <input v-model="timestamps" type="checkbox" /> Timestamps
      </label>
      <label class="flex items-center gap-1.5">
        <input v-model="previous" type="checkbox" /> Previous
      </label>
      <label class="flex items-center gap-1.5">
        <input v-model="follow" type="checkbox" /> Follow
      </label>
      <label class="flex items-center gap-1.5">
        <input v-model="wrap" type="checkbox" /> Wrap
      </label>
      <!-- Icon-only: the label lives in title/aria-label. -->
      <BaseButton title="Reload logs" aria-label="Reload logs" @click="restart">
        <AppIcon name="arrow-path" class="h-4 w-4" />
      </BaseButton>
      <BaseButton
        :disabled="downloading"
        :title="downloading ? 'Downloading the full log…' : 'Download the full log'"
        :aria-label="downloading ? 'Downloading the full log' : 'Download the full log'"
        @click="download"
      >
        <!-- Busy state reuses the reload arrows, spinning: the toolbar keeps
             its width and the button still says what it is doing. -->
        <AppIcon
          :name="downloading ? 'arrow-path' : 'arrow-down-tray'"
          class="h-4 w-4"
          :class="downloading ? 'animate-spin' : ''"
        />
      </BaseButton>
      <span v-if="stream.running.value" class="text-xs text-green-600 dark:text-green-400">
        ● streaming
      </span>
    </div>

    <p
      v-for="message in errors"
      :key="message"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
    >
      {{ message }}
    </p>

    <p
      v-if="stream.truncated.value"
      class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
    >
      The start of the log was dropped — the viewer keeps the last
      {{ MAX_LINES.toLocaleString() }} lines. Use Download for the full log.
    </p>

    <div class="min-h-0 flex-1">
      <LogViewer :lines="stream.lines.value" :follow="follow" :wrap="wrap" />
    </div>
  </div>
</template>
