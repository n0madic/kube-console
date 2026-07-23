<script setup lang="ts">
// Cluster context picker (presentational). A custom listbox rather than
// <select>: a native popup caps its own height and scrolls at the browser's
// discretion, which is unhelpful for long context names.
// Owners: ClusterSelector (sidebar) and LoginPage.

import { computed, onBeforeUnmount, onMounted, ref, useId } from "vue"

import AppIcon from "@/components/ui/AppIcon.vue"
import type { ContextItem } from "@/utils/contextItems"

const props = defineProps<{
  /** Rows to offer, in display order — always built with `contextItems()`. */
  items: ContextItem[]
  /** Currently active context ("" before the first login). */
  selected: string
}>()

const emit = defineEmits<{ select: [name: string] }>()

const open = ref(false)
const activeIndex = ref(0)
const root = ref<HTMLElement | null>(null)

const label = computed(() => (props.selected !== "" ? props.selected : "Select cluster"))

// Clamped on read: the item list can shrink while the panel is open (a context
// removed upstream), and a stale index would highlight nothing while Enter
// picked nothing.
const highlighted = computed(() => Math.min(activeIndex.value, props.items.length - 1))

// The trigger keeps the focus while the panel is open (ARIA's select-only
// combobox), so the highlighted option has to be pointed at by id. Both pickers
// can exist in one document, hence a per-instance prefix.
const uid = useId()
const listId = `${uid}-listbox`
const optionId = (index: number): string => `${uid}-option-${index}`
const activeOptionId = computed(() =>
  open.value && highlighted.value >= 0 ? optionId(highlighted.value) : undefined,
)

function openMenu(): void {
  const current = props.items.findIndex((c) => c.name === props.selected)
  activeIndex.value = current >= 0 ? current : 0
  open.value = true
}

function close(): void {
  open.value = false
}

function toggle(): void {
  if (open.value) close()
  else openMenu()
}

function move(delta: number): void {
  if (props.items.length === 0) return
  const next = highlighted.value + delta
  activeIndex.value = Math.min(Math.max(next, 0), props.items.length - 1)
}

function select(name: string): void {
  close()
  if (name === "") return
  emit("select", name)
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case "Escape":
      if (open.value) {
        event.preventDefault()
        close()
      }
      break
    case "ArrowDown":
      event.preventDefault()
      if (open.value) move(1)
      else openMenu()
      break
    case "ArrowUp":
      event.preventDefault()
      if (open.value) move(-1)
      else openMenu()
      break
    case "Enter":
    case " ":
      event.preventDefault()
      if (open.value) select(props.items[highlighted.value]?.name ?? "")
      else openMenu()
      break
    case "Tab":
      close()
      break
  }
}

function onDocumentPointerDown(event: MouseEvent): void {
  if (root.value !== null && !root.value.contains(event.target as Node)) close()
}

onMounted(() => document.addEventListener("mousedown", onDocumentPointerDown))
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocumentPointerDown))
</script>

<template>
  <div ref="root" class="relative" @keydown="onKeydown">
    <!-- role=combobox, not a plain button: the accessible name then comes from
         aria-label and the *content* is read as the current value, so the
         selected cluster is announced. A button's name would swallow it. -->
    <button
      type="button"
      role="combobox"
      aria-label="Cluster context"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="open ? listId : undefined"
      :aria-activedescendant="activeOptionId"
      :title="selected"
      class="flex w-full items-center gap-2 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
      @click="toggle"
    >
      <AppIcon name="layers" class="h-4 w-4 shrink-0 text-slate-400" />
      <span class="min-w-0 flex-1 truncate text-left">{{ label }}</span>
      <AppIcon name="caret-down" class="h-4 w-4 shrink-0 text-slate-400" />
    </button>

    <ul
      v-if="open"
      :id="listId"
      role="listbox"
      aria-label="Cluster context"
      class="absolute left-0 right-0 z-30 mt-1 max-h-[70vh] overflow-y-auto rounded-md border border-slate-300 bg-white py-1 shadow-lg dark:border-slate-600 dark:bg-slate-800"
    >
      <li
        v-for="(ctx, i) in items"
        :id="optionId(i)"
        :key="ctx.name"
        role="option"
        :aria-selected="ctx.name === selected"
        :title="ctx.name"
        class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm text-slate-700 dark:text-slate-200"
        :class="[
          i === highlighted ? 'bg-slate-100 dark:bg-slate-700' : '',
          ctx.name === selected ? 'font-semibold' : '',
        ]"
        @mouseenter="activeIndex = i"
        @click="select(ctx.name)"
      >
        <span class="min-w-0 flex-1 truncate" data-testid="ctx-name">{{ ctx.name }}</span>
        <!-- Signed in = this tab holds an unexpired token for that cluster, so
             picking it switches straight over instead of going through login. -->
        <span
          v-if="ctx.signedIn"
          class="shrink-0 rounded-sm bg-emerald-100 px-1 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300"
          title="Signed in: a token for this context is stored in this tab"
        >
          signed in
        </span>
      </li>
    </ul>
  </div>
</template>
