<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual"
import { computed, ref, watch } from "vue"

import { logTokenClass, tokenizeJsonLine, type LogToken } from "@/utils/logJson"

const props = defineProps<{ lines: string[]; follow: boolean; wrap?: boolean }>()

const scrollRef = ref<HTMLElement | null>(null)

const virtualizer = useVirtualizer(
  computed(() => {
    const el = scrollRef.value
    return {
      count: props.lines.length,
      getScrollElement: () => el,
      estimateSize: () => 20,
      overscan: 30,
      initialRect: { width: 1024, height: 600 },
    }
  }),
)

// Wrapped lines have no known height, so they are measured after render;
// unwrapped ones stay on the cheap fixed-height path (no ResizeObserver per
// line), which is what a long log stream is normally rendered with.
function measure(el: Element | null): void {
  // A null ref is the unmount hook: it prunes detached rows from the
  // virtualizer's ResizeObserver, so it must be forwarded either way.
  if (el === null) virtualizer.value.measureElement(null)
  else if (props.wrap === true) virtualizer.value.measureElement(el)
}

// Toggling wrap invalidates every cached row height.
watch(
  () => props.wrap,
  () => virtualizer.value.measure(),
)

const totalSize = computed(() => virtualizer.value.getTotalSize())

// Only the visible slice is ever tokenized, but the same rows are re-derived on
// every scroll frame, so results are memoized by line text. The cache is
// per-instance (it dies with the component) and bounded — logs are unbounded
// and mostly unique, so it is dropped wholesale rather than grown forever.
const CACHE_LIMIT = 4000
const tokenCache = new Map<string, LogToken[] | null>()

function tokensOf(line: string): LogToken[] | null {
  const cached = tokenCache.get(line)
  if (cached !== undefined) return cached
  const tokens = tokenizeJsonLine(line)
  if (tokenCache.size >= CACHE_LIMIT) tokenCache.clear()
  tokenCache.set(line, tokens)
  return tokens
}

const rows = computed(() =>
  virtualizer.value.getVirtualItems().map((item) => {
    const text = props.lines[item.index] ?? ""
    return { index: item.index, start: item.start, text, tokens: tokensOf(text) }
  }),
)

watch(
  () => props.lines.length,
  () => {
    if (props.follow && props.lines.length > 0) {
      virtualizer.value.scrollToIndex(props.lines.length - 1, { align: "end" })
    }
  },
)
</script>

<template>
  <div
    ref="scrollRef"
    class="h-full overflow-auto rounded-md bg-slate-950 p-2 font-mono text-xs text-slate-200"
  >
    <div :style="{ height: `${totalSize}px`, position: 'relative' }">
      <div
        v-for="row in rows"
        :key="row.index"
        :ref="(el) => measure(el as Element | null)"
        :data-index="row.index"
        class="absolute left-0 top-0 w-full"
        :class="wrap === true ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'"
        :style="
          wrap === true
            ? { transform: `translateY(${row.start}px)` }
            : { transform: `translateY(${row.start}px)`, height: '20px' }
        "
      ><template v-if="row.tokens !== null"><span
          v-for="(token, i) in row.tokens"
          :key="i"
          :class="logTokenClass(token)"
        >{{ token.text }}</span></template><template v-else>{{ row.text }}</template></div>
    </div>
    <p v-if="lines.length === 0" class="p-4 text-slate-500">No log output.</p>
  </div>
</template>
