<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import { onBeforeUnmount, onMounted, ref } from "vue"

const emit = defineEmits<{ data: [text: string]; resize: [cols: number, rows: number] }>()

const host = ref<HTMLElement | null>(null)
let term: Terminal | null = null
let fit: FitAddon | null = null

// The terminal stays mounted but hidden while another tab of the pod page is
// open (so the exec session survives a tab switch), and a hidden element cannot
// be measured: under display:none getComputedStyle hands FitAddon the declared
// "100%", which it would turn into a ~2x5 grid and push upstream as a resize.
// Fit only while visible; the owner refits when the tab comes back.
function isVisible(): boolean {
  const el = host.value
  return el !== null && el.clientWidth > 0 && el.clientHeight > 0
}

onMounted(() => {
  if (host.value === null) return
  term = new Terminal({
    fontSize: 13,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    cursorBlink: true,
    theme: { background: "#0f172a" },
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host.value)
  fitNow()
  term.onData((data) => emit("data", data))
  term.onResize(({ cols, rows }) => emit("resize", cols, rows))
  window.addEventListener("resize", fitNow)
})

onBeforeUnmount(() => {
  window.removeEventListener("resize", fitNow)
  term?.dispose()
  term = null
  fit = null
})

function write(data: Uint8Array | string): void {
  term?.write(data)
}

function focus(): void {
  term?.focus()
}

function fitNow(): void {
  if (isVisible()) fit?.fit()
}

function size(): { cols: number; rows: number } | null {
  return term !== null ? { cols: term.cols, rows: term.rows } : null
}

defineExpose({ write, focus, fitNow, size })
</script>

<template>
  <div ref="host" class="h-full min-h-0 w-full overflow-hidden rounded-md bg-[#0f172a] p-1"></div>
</template>
