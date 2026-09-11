// Search state for the Logs tab, kept beside the stream that owns the buffer.
//
// The viewer is virtualized, so the browser's Find sees a sliver of the
// buffer; this searches the buffer itself and hands the viewer the verdicts
// (`compiled`, `matches`, `active`) to paint and scroll by. The matching is
// pure (`utils/logSearch`); this owns the query, the debounce, the incremental
// rescan and the cursor through the hits.

import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue"

import { compileQuery, scanLines, type LogQuery } from "@/utils/logSearch"

// A full scan of a 200k-line buffer per keystroke is what the debounce avoids.
const DEBOUNCE_MS = 150

export function useLogSearch(lines: Ref<string[]>, version: Ref<number>, dropped: Ref<number>) {
  const query = ref("")
  const filter = ref(false)

  const debounced = ref("")
  let timer: ReturnType<typeof setTimeout> | null = null
  watch(query, (value) => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      debounced.value = value
    }, DEBOUNCE_MS)
  })
  // Enter right after typing means "search for this now": a pending debounce
  // is applied on the spot rather than letting the keypress land on the
  // previous query's matches (or, with none yet, on nothing).
  function settle(): void {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
    debounced.value = query.value
  }
  onScopeDispose(() => {
    if (timer !== null) clearTimeout(timer)
  })

  const compiled = computed(() => compileQuery(debounced.value))

  // Ascending line indices. A NEW array on every update, so consumers can
  // depend on its identity without a version counter of their own.
  const matches = shallowRef<number[]>([])
  // Position within `matches`, null while nothing is selected.
  const active = ref<number | null>(null)
  // Bumped by next()/prev(): the jump is an event, not a state read. With a
  // single match Enter goes 0 → 0, and after scrolling away to read context a
  // second Enter must still re-center it.
  const jumpSeq = ref(0)

  // The raw checkbox is not what the viewer gets: with Filter on and the field
  // cleared, `matches` is empty and the viewer would render an empty log.
  const filtering = computed(() => filter.value && compiled.value !== null)

  // Bookkeeping for the incremental path.
  let lastQuery: LogQuery | null = null
  let lastLines: string[] | null = null
  let lastLen = 0
  let lastDropped = 0

  function rescan(q: LogQuery, buffer: string[]): void {
    matches.value = scanLines(buffer, q)
    active.value = null
  }

  // The stream appends into the same array in place and announces it through
  // `version`; at the cap every flush also drops a head, counted by `dropped`.
  // `dropped` is deliberately read inside rather than watched: it moves in the
  // same synchronous flush as `version`, and the shift needs its value now.
  // Synchronous so that `settle()` above leaves `matches` current for the
  // next()/prev() that called it; a flush arrives at most every 50ms.
  watch(
    [compiled, version],
    () => {
      const q = compiled.value
      const buffer = lines.value
      if (q === null) {
        matches.value = []
        active.value = null
      } else if (q !== lastQuery || buffer !== lastLines) {
        // A new query, or a restart handing over a fresh array.
        rescan(q, buffer)
      } else {
        const delta = dropped.value - lastDropped
        const previous = matches.value
        let kept = 0
        while (kept < previous.length && (previous[kept] ?? 0) < delta) kept++
        const removed = kept
        const next: number[] = new Array(previous.length - removed)
        for (let i = removed; i < previous.length; i++)
          next[i - removed] = (previous[i] ?? 0) - delta
        for (const i of scanLines(buffer, q, Math.max(0, lastLen - delta))) next.push(i)
        matches.value = next
        if (active.value !== null) {
          const shifted = active.value - removed
          active.value = shifted < 0 ? null : shifted
        }
      }
      lastQuery = q
      lastLines = buffer
      lastLen = buffer.length
      lastDropped = dropped.value
    },
    { flush: "sync" },
  )

  function move(step: 1 | -1): void {
    settle()
    const count = matches.value.length
    if (count === 0) return
    const current = active.value
    if (current === null) active.value = step === 1 ? 0 : count - 1
    else active.value = (current + step + count) % count
    jumpSeq.value++
  }

  function next(): void {
    move(1)
  }

  function prev(): void {
    move(-1)
  }

  // Filter stays as chosen: it is a mode, and `filtering` already answers
  // false while there is no query.
  function clear(): void {
    query.value = ""
    active.value = null
  }

  return {
    query,
    filter,
    compiled,
    matches,
    active,
    filtering,
    jumpSeq,
    next,
    prev,
    clear,
  }
}
