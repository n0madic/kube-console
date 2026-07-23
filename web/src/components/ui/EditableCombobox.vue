<script setup lang="ts">
// Editable combobox: a free-text input that also offers a fixed list of
// suggestions. HTML has no such control — `<input list>` looks like one but a
// datalist *filters* its options by what the field already contains, so a
// prefilled field hides every suggestion but its own (the bug this replaces).
// So it is built by hand, following ARIA's editable-combobox pattern: the
// input owns the focus and the popup is pointed at with aria-activedescendant.

import { computed, onBeforeUnmount, onMounted, ref, useId } from "vue"

import AppIcon from "@/components/ui/AppIcon.vue"

export interface ComboboxOption {
  /** Text put into the field when the option is picked. */
  value: string
  /**
   * Human label. Shown over the value in the popup, and — while the field
   * holds exactly this value and is not being edited — *instead* of it in the
   * field, so a one-liner shell script does not have to be read as one.
   */
  label: string
  /** Optional note beside the label in the popup; never enters the field. */
  hint?: string
}

const props = withDefaults(
  defineProps<{
    options: ComboboxOption[]
    /** Accessible name for the input and the popup. */
    label: string
    disabled?: boolean
    placeholder?: string
  }>(),
  { disabled: false, placeholder: "" },
)

const model = defineModel<string>({ required: true })

const open = ref(false)
const activeIndex = ref(0)
const root = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)

// Clamped on read, like the context picker: the option list is a prop and can
// shrink while the panel is open, and a stale index would highlight nothing
// while Enter picked nothing.
const highlighted = computed(() => Math.min(activeIndex.value, props.options.length - 1))

// Display alias: an unfocused field shows the label of the option it holds
// (the auto shell is a `sh -c` one-liner that would otherwise fill the
// toolbar), and reveals the real command line the moment it is focused — so
// editing always starts from what actually runs, and nothing is hidden from
// someone about to change it. The model is *always* the command line; `title`
// carries it in either state.
const focused = ref(false)
const pickedOption = computed(() => props.options.find((o) => o.value === model.value) ?? null)
const display = computed(() =>
  !focused.value && pickedOption.value !== null ? pickedOption.value.label : model.value,
)

const uid = useId()
const listId = `${uid}-listbox`
const optionId = (index: number): string => `${uid}-option-${index}`
const activeOptionId = computed(() =>
  open.value && highlighted.value >= 0 ? optionId(highlighted.value) : undefined,
)

function openMenu(): void {
  if (props.disabled) return
  // Start from whatever the field currently holds, so arrowing from a picked
  // suggestion continues down the list instead of jumping back to the top.
  const current = props.options.findIndex((o) => o.value === model.value)
  activeIndex.value = current >= 0 ? current : 0
  open.value = true
}

function close(): void {
  open.value = false
}

function toggle(): void {
  if (open.value) close()
  else openMenu()
  input.value?.focus()
}

function move(delta: number): void {
  if (props.options.length === 0) return
  activeIndex.value = Math.min(Math.max(highlighted.value + delta, 0), props.options.length - 1)
}

function pick(index: number): void {
  const option = props.options[index]
  close()
  if (option === undefined) return
  model.value = option.value
  // Focus returns to the combobox (it is the only tab stop), which means the
  // field shows the picked command line rather than its label — so put the
  // caret at the start, where the command itself is, not at the end of a long
  // script the pick was meant to spare the user from reading.
  input.value?.focus()
  input.value?.setSelectionRange(0, 0)
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
      // Only while the popup is open: otherwise Enter belongs to the form the
      // field sits in, and typing a command must not be hijacked.
      if (open.value) {
        event.preventDefault()
        pick(highlighted.value)
      }
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
    <!-- A disabled combobox must read as disabled at a glance: its owner locks
         it while a session is running, and an unstyled locked field just looks
         like a field that ignores clicks. -->
    <div
      class="flex items-center rounded-md border border-slate-300 bg-white pr-1 dark:border-slate-600 dark:bg-slate-800"
      :class="disabled ? 'cursor-not-allowed opacity-60' : 'focus-within:border-sky-500'"
    >
      <input
        ref="input"
        :value="display"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        :aria-label="label"
        :aria-expanded="open"
        :aria-controls="open ? listId : undefined"
        :aria-activedescendant="activeOptionId"
        :disabled="disabled"
        :placeholder="placeholder"
        :title="model"
        spellcheck="false"
        autocomplete="off"
        class="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 font-mono outline-none disabled:cursor-not-allowed"
        @input="model = ($event.target as HTMLInputElement).value"
        @focus="focused = true"
        @blur="focused = false"
      />
      <!-- Not in the tab order (ARIA's editable combobox keeps a single stop):
           the same popup opens with ArrowDown from the input. -->
      <button
        type="button"
        tabindex="-1"
        :disabled="disabled"
        :aria-label="`Show ${label} suggestions`"
        class="shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-600 disabled:cursor-not-allowed dark:hover:text-slate-200"
        @click="toggle"
      >
        <AppIcon name="caret-down" class="h-4 w-4" />
      </button>
    </div>

    <ul
      v-if="open"
      :id="listId"
      role="listbox"
      :aria-label="label"
      class="absolute left-0 right-0 z-30 mt-1 max-h-[60vh] min-w-max overflow-y-auto rounded-md border border-slate-300 bg-white py-1 shadow-lg dark:border-slate-600 dark:bg-slate-800"
    >
      <li
        v-for="(option, i) in options"
        :id="optionId(i)"
        :key="option.value"
        role="option"
        :aria-selected="option.value === model"
        class="cursor-pointer px-2 py-1.5 text-sm text-slate-700 dark:text-slate-200"
        :class="i === highlighted ? 'bg-slate-100 dark:bg-slate-700' : ''"
        @mouseenter="activeIndex = i"
        @click="pick(i)"
      >
        <span class="flex items-baseline gap-2">
          <span class="font-mono">{{ option.label }}</span>
          <span v-if="option.hint !== undefined" class="text-xs text-slate-500 dark:text-slate-400">
            {{ option.hint }}
          </span>
        </span>
        <!-- What the field would hold, shown only when the label is an alias
             for something longer. -->
        <span
          v-if="option.value !== option.label"
          class="block truncate font-mono text-xs text-slate-500 dark:text-slate-400"
        >
          {{ option.value }}
        </span>
      </li>
    </ul>
  </div>
</template>
