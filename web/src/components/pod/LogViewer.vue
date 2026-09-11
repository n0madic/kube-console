<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual"
import { computed, ref, watch } from "vue"

import { tokenizeJsonLine, type LogToken } from "@/utils/logJson"
import { matchRanges, segmentLine, type LogQuery } from "@/utils/logSearch"

const props = defineProps<{
  lines: string[]
  /** Bumped by the producer on every mutation of `lines` — see `buffer` below. */
  version: number
  follow: boolean
  wrap?: boolean
  /** The search in force, for highlighting; null renders every line plain. */
  query?: LogQuery | null
  /** Ascending indices of the matching lines — a new array on every update. */
  matches?: number[]
  /** Render only the matching lines. */
  filter?: boolean
  /** Position within `matches` of the selected hit, null for none. */
  activeMatch?: number | null
  /** Bumped by the owner on every jump request: an event, not a state read. */
  jumpSeq?: number
}>()

const scrollRef = ref<HTMLElement | null>(null)

// The one dependency everything below reads the buffer through, because neither
// of its two parts is a complete signal on its own. `useLogsStream` appends into
// the same array in place (copying a 200k-line buffer per flush was quadratic in
// the lines loaded), so during a stream the identity never changes and — once
// MAX_LINES caps it — neither does the length; `version` is what changes. And
// `version` alone would not survive a restart handing over a fresh array. The
// search verdicts ride along, so the visible slice re-derives on every one.
const buffer = computed(() => ({
  lines: props.lines,
  version: props.version,
  matches: props.matches ?? [],
  filter: props.filter === true,
}))

// In filter mode the rows are the matches; otherwise every line is a row.
const count = computed(() =>
  buffer.value.filter ? buffer.value.matches.length : buffer.value.lines.length,
)

function lineIndexOf(row: number): number {
  return buffer.value.filter ? (buffer.value.matches[row] ?? 0) : row
}

const virtualizer = useVirtualizer(
  computed(() => {
    const el = scrollRef.value
    return {
      count: count.value,
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

// The line index of the selected hit, or -1 — resolved once per render, not
// per row.
const activeLine = computed(() => {
  const at = props.activeMatch
  if (at === null || at === undefined) return -1
  return buffer.value.matches[at] ?? -1
})

// Read through `buffer`, not `props.lines`: the visible slice must be re-derived
// for the same indices when the head is trimmed in place, which shifts every
// line up by the number dropped. `index` stays the virtualizer's item index —
// virtual-core's measureElement finds the measured item through `data-index` —
// and `line` is the position in the buffer, which differs under a filter.
const rows = computed(() => {
  const q = props.query ?? null
  return virtualizer.value.getVirtualItems().map((item) => {
    const line = lineIndexOf(item.index)
    const text = buffer.value.lines[line] ?? ""
    const ranges = q === null ? [] : matchRanges(q, text)
    return {
      index: item.index,
      line,
      start: item.start,
      segments: segmentLine(text, tokensOf(text), ranges),
    }
  })
})

// Keyed on the array and its version, never on the line count: `useLogsStream`
// caps the buffer at MAX_LINES, so once a chatty container reaches the cap the
// length stops changing while lines keep arriving — a count watcher would stop
// firing exactly there and Follow would silently freeze. Not on `buffer` as a
// whole either: `matches` changes on every keystroke of the query, and a
// followed-but-finished stream must not jump to its end while the user reads
// higher up — only a flush (or the filter toggle, which re-derives the rows)
// re-anchors. Paused while a hit is selected: the stream keeps running, but a
// jump to a match must not be undone by the next flush. The query being
// cleared (Esc) is itself a source, so a quiet stream goes back to its end at
// once rather than on whatever line arrives next — but only the *clearing*:
// refining the query after Enter also drops the selection (a full rescan), and
// re-anchoring on that would yank the view away mid-typing. The target is the
// last *visible* row, which under a filter is the last match.
//
// `flush: "post"`, and so is the jump below: a scroll is clamped to the
// scroll element's height *as laid out*, and that height is the spacer div
// `totalSize` sizes in the render. A pre-flush watcher scrolls before that
// render, so the request was clamped to the previous height — measured against
// a real apiserver: a 500-line tail loaded in one flush stayed at the top, and
// clearing a filter left the view a whole buffer short of the end.
function followToEnd(): void {
  if (!props.follow || activeLine.value !== -1) return
  const n = count.value
  if (n > 0) virtualizer.value.scrollToIndex(n - 1, { align: "end" })
}

// Multi-source, compared element-wise — a getter returning a fresh tuple
// counts as changed whenever any dependency it read moves.
watch([() => props.lines, () => props.version, () => props.filter], followToEnd, {
  flush: "post",
})

watch(
  () => (props.query ?? null) === null,
  (cleared) => {
    if (cleared) followToEnd()
  },
  { flush: "post" },
)

// A jump is an event: with one match Enter goes 0 → 0, and after scrolling
// away to read context a second Enter must still re-center it, so this fires
// on the counter rather than on the position.
watch(
  () => props.jumpSeq,
  () => {
    const at = props.activeMatch
    if (at === null || at === undefined) return
    const row = buffer.value.filter ? at : buffer.value.matches[at]
    if (row === undefined || row >= count.value) return
    virtualizer.value.scrollToIndex(row, { align: "center" })
  },
  { flush: "post" },
)
</script>

<template>
  <div
    ref="scrollRef"
    class="h-full overflow-auto rounded-md bg-slate-950 p-2 font-mono text-xs text-slate-200"
  >
    <div :style="{ height: `${totalSize}px`, position: 'relative' }">
      <!-- Hits are <mark>s around the original substrings — still no v-html.
           One class expression per piece (Tailwind order gotcha), and
           `text-inherit` on a plain-text mark because the UA stylesheet paints
           mark black. -->
      <div
        v-for="row in rows"
        :key="row.index"
        :ref="(el) => measure(el as Element | null)"
        :data-index="row.index"
        :data-line="row.line"
        class="absolute left-0 top-0 w-full"
        :class="[
          wrap === true ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
          row.line === activeLine ? 'bg-sky-900/60' : '',
        ]"
        :style="
          wrap === true
            ? { transform: `translateY(${row.start}px)` }
            : { transform: `translateY(${row.start}px)`, height: '20px' }
        "
      ><template v-for="(seg, i) in row.segments" :key="i"><mark
          v-if="seg.hit"
          class="rounded-sm bg-amber-400/50"
          :class="seg.cls === '' ? 'text-inherit' : seg.cls"
        >{{ seg.text }}</mark><span v-else-if="seg.cls !== ''" :class="seg.cls">{{ seg.text }}</span><template v-else>{{ seg.text }}</template></template></div>
    </div>
    <p v-if="buffer.lines.length === 0" class="p-4 text-slate-500">No log output.</p>
    <p v-else-if="count === 0" class="p-4 text-slate-500">No matching lines.</p>
  </div>
</template>
