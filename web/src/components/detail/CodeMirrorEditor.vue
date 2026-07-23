<script setup lang="ts">
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { yaml } from "@codemirror/lang-yaml"
import {
  bracketMatching,
  codeFolding,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language"
import { Compartment, EditorState } from "@codemirror/state"
import { oneDark } from "@codemirror/theme-one-dark"
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view"
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"

import { usePreferencesStore } from "@/stores/preferences"

const props = withDefaults(defineProps<{ readonly?: boolean }>(), { readonly: false })
const model = defineModel<string>({ required: true })

const prefs = usePreferencesStore()
const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null
const themeCompartment = new Compartment()

// Same formula as App.vue: explicit theme wins, "system" follows the OS.
const isDark = computed(() => {
  const theme = prefs.prefs.theme
  if (theme === "dark") return true
  if (theme === "light") return false
  return window.matchMedia("(prefers-color-scheme: dark)").matches
})

const lightTheme = EditorView.theme(
  {
    "&": { backgroundColor: "#ffffff", color: "#1e293b" },
    ".cm-gutters": { backgroundColor: "#f8fafc", color: "#94a3b8", border: "none" },
  },
  { dark: false },
)

function themeExtension() {
  return isDark.value ? oneDark : lightTheme
}

onMounted(() => {
  if (host.value === null) return
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: model.value,
      extensions: [
        // Hand-picked minimal set (no autocomplete/lint/search — unused here);
        // keeps YAML highlighting, line numbers, code folding and editing
        // keymaps. Folding is worth its weight on large manifests and rides on
        // @codemirror/language which is already bundled.
        lineNumbers(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        codeFolding(),
        foldGutter(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
        yaml(),
        EditorState.readOnly.of(props.readonly),
        themeCompartment.of(themeExtension()),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const text = update.state.doc.toString()
            if (text !== model.value) model.value = text
          }
        }),
        EditorView.theme({
          "&": { fontSize: "13px", height: "100%" },
          ".cm-scroller": { fontFamily: "ui-monospace, monospace" },
        }),
      ],
    }),
  })
})

watch(model, (text) => {
  if (view !== null && view.state.doc.toString() !== text) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  }
})

watch(isDark, () => {
  view?.dispatch({ effects: themeCompartment.reconfigure(themeExtension()) })
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})
</script>

<template>
  <div
    ref="host"
    class="h-full min-h-0 overflow-hidden rounded-md border border-slate-200 dark:border-slate-700"
  ></div>
</template>
