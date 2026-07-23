// Reveal state for masked values (Secret data, Secret-backed env vars): tracks
// which items the user has explicitly un-masked via the eye button. The set is
// in-memory only — never persisted, never logged — so decoded values never
// touch storage. `keyOf` maps an item to a stable identity; pass `resetOn` to
// auto-clear when a source changes (e.g. the detail object's uid) so a value
// revealed on one object never auto-reveals a same-keyed value on the next.

import { ref, watch, type WatchSource } from "vue"

export interface Reveal<T> {
  isRevealed: (item: T) => boolean
  toggle: (item: T) => void
  reset: () => void
}

export function useReveal<T>(keyOf: (item: T) => string, resetOn?: WatchSource): Reveal<T> {
  const revealed = ref<Set<string>>(new Set())

  function isRevealed(item: T): boolean {
    return revealed.value.has(keyOf(item))
  }

  function toggle(item: T): void {
    const key = keyOf(item)
    const next = new Set(revealed.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    revealed.value = next
  }

  function reset(): void {
    revealed.value = new Set()
  }

  if (resetOn !== undefined) watch(resetOn, reset)

  return { isRevealed, toggle, reset }
}
