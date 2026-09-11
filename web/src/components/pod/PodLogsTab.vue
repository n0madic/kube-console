<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue"

import { apiFetch, messageFromError } from "@/api/http"
import { logsUrl } from "@/api/k8s"
import type { K8sObject } from "@/api/types"
import AppIcon from "@/components/ui/AppIcon.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import PopoverMenu from "@/components/ui/PopoverMenu.vue"
import { useLogSearch } from "@/composables/useLogSearch"
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

// The previous/next match buttons: the bare shape RevealButton uses rather
// than BaseButton's padded one — they belong to the search field, not to the
// toolbar's button row, and the padded shape read as two more toolbar buttons.
const ICON_BUTTON_CLASS =
  "rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 " +
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent " +
  "dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"

// Searches the buffer, not the DOM: the viewer is virtualized, so the
// browser's Find sees a sliver of the log. The query deliberately survives a
// restart — the composable rescans on its own when the array is replaced.
const search = useLogSearch(stream.lines, stream.linesVersion, stream.dropped)
const searchField = ref<HTMLInputElement | null>(null)

const matchCount = computed(() => search.matches.value.length)
const matchSummary = computed(() => {
  if (search.compiled.value === null) return ""
  const n = matchCount.value
  if (n === 0) return "No matches"
  const at = search.active.value
  if (at !== null) return `${at + 1} / ${n}`
  return n === 1 ? "1 match" : `${n} matches`
})

// All three prevent the default — Escape in particular: AppShell's drawer
// handler and the pickers key on defaultPrevented, and an unprevented Escape
// from here would also dismiss the sidebar drawer on a narrow viewport.
function onSearchKeydown(e: KeyboardEvent): void {
  switch (e.key) {
    case "Enter":
      e.preventDefault()
      if (e.shiftKey) search.prev()
      else search.next()
      break
    case "Escape":
      e.preventDefault()
      search.clear()
      break
  }
}

// Ctrl/Cmd+F goes to the field while this tab is mounted — it is v-else-if'd in
// ResourceDetailPage, so the listener exists only while Logs is open. Matched
// on the physical key like the browser's own Find: `e.key` is "а" on a
// Russian layout and "F" under CapsLock.
function onWindowKeydown(e: KeyboardEvent): void {
  if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
  if (e.code !== "KeyF") return
  e.preventDefault()
  searchField.value?.focus()
  searchField.value?.select()
}
onMounted(() => window.addEventListener("keydown", onWindowKeydown))
onUnmounted(() => window.removeEventListener("keydown", onWindowKeydown))

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

// URL a dropped follow stream reconnects with. `sinceSeconds` is the window the
// composable measured from the last line it received — the log endpoint has no
// cursor — and it replaces the tail: the buffer already holds everything up to
// there. Nothing received yet (null) means the original request still describes
// what is wanted.
function resumeUrl(sinceSeconds: number | null): string | null {
  if (sinceSeconds === null) return currentUrl()
  const meta = props.object.metadata
  if (meta?.namespace === undefined || meta.name === undefined) return null
  return logsUrl(meta.namespace, meta.name, {
    container: container.value,
    sinceSeconds,
    timestamps: timestamps.value,
    previous: previous.value,
    follow: true,
  })
}

// URL the stream was last started with, so the option watcher can tell a real
// change from the echo of a change the mount / pod-change path already acted on.
let startedUrl: string | null = null

function restart(): void {
  const url = currentUrl()
  if (url === null) return
  startedUrl = url
  // Only a followed stream reconnects: an unfollowed read ends by design.
  void stream.start(url, follow.value ? { resume: resumeUrl } : {})
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
    <div class="flex flex-wrap items-center gap-2 text-sm">
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
      <!-- Set once, then left alone for the life of the tab: they sit behind
           one button rather than taking four slots of a row that also has to
           hold the search. Follow's state stays visible through the streaming
           indicator. -->
      <PopoverMenu label="Log options" icon="cog-6-tooth">
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
      </PopoverMenu>
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
      <span
        v-if="stream.reconnecting.value !== null"
        class="text-xs text-amber-600 dark:text-amber-400"
      >
        ● reconnecting…
      </span>
      <!-- A selected match pauses the follow scroll (the stream keeps running),
           and a paused follow must be stated rather than look frozen. -->
      <span v-else-if="stream.running.value" class="text-xs text-green-600 dark:text-green-400">
        ● streaming{{ search.active.value !== null ? " (scroll paused)" : "" }}
      </span>
      <!-- The search group takes whatever the options leave and gives it to
           the field (flex-1 between its min and max widths), so a narrower
           row squeezes the field before it wraps the group; the basis is the
           width at which wrapping is preferable to a field too small to read.
           The field paints its own focus border like the login page: the UA
           focus ring of a `search` input is a double ring that reads as a
           rendering glitch on the dark theme. -->
      <div class="ml-auto flex min-w-0 flex-1 basis-[17rem] items-center justify-end gap-1.5">
        <input
          ref="searchField"
          v-model="search.query.value"
          type="search"
          aria-label="Search log"
          placeholder="Search…"
          class="min-w-[5rem] max-w-36 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-blue-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          @keydown="onSearchKeydown"
        />
        <span
          v-if="matchSummary !== ''"
          class="whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400"
        >
          {{ matchSummary }}
        </span>
        <button
          type="button"
          :class="ICON_BUTTON_CLASS"
          :disabled="matchCount === 0"
          title="Previous match"
          aria-label="Previous match"
          @click="search.prev"
        >
          <AppIcon name="chevron-up" class="h-4 w-4" />
        </button>
        <button
          type="button"
          :class="ICON_BUTTON_CLASS"
          :disabled="matchCount === 0"
          title="Next match"
          aria-label="Next match"
          @click="search.next"
        >
          <AppIcon name="chevron-down" class="h-4 w-4" />
        </button>
        <label class="flex items-center gap-1.5 whitespace-nowrap">
          <input v-model="search.filter.value" type="checkbox" /> Filter
        </label>
      </div>
    </div>

    <p
      v-for="message in errors"
      :key="message"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
    >
      {{ message }}
    </p>

    <!-- A dropped follow stream is not an error the user has to act on: say
         what happened, in place, while the reconnect runs. -->
    <p
      v-if="stream.reconnecting.value !== null"
      class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
    >
      {{ stream.reconnecting.value }} Reconnecting…
    </p>

    <p
      v-if="stream.truncated.value"
      class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
    >
      The start of the log was dropped — the viewer keeps the last
      {{ MAX_LINES.toLocaleString() }} lines. Use Download for the full log.
    </p>

    <div class="min-h-0 flex-1">
      <!-- The stream appends into the same array in place, so the viewer needs
           the version counter to see it change at all. -->
      <LogViewer
        :lines="stream.lines.value"
        :version="stream.linesVersion.value"
        :follow="follow"
        :wrap="wrap"
        :query="search.compiled.value"
        :matches="search.matches.value"
        :filter="search.filtering.value"
        :active-match="search.active.value"
        :jump-seq="search.jumpSeq.value"
      />
    </div>
  </div>
</template>
