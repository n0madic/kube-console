<script setup lang="ts">
import { computed } from "vue"
import type { RouteLocationRaw } from "vue-router"

const props = withDefaults(
  defineProps<{
    title: string
    /** Secondary line, e.g. "0.82 / 8 cores" or "2 / 2 Ready". */
    detail: string
    /** 0..100 utilization; null when the value is unknown (e.g. no metrics). */
    percent: number | null
    /** "usage": higher = worse (green→amber→red). "health": higher = better. */
    variant?: "usage" | "health"
    /** When set, the whole card becomes a link to this route. */
    to?: RouteLocationRaw
  }>(),
  { variant: "usage", to: undefined },
)

// r chosen so the circumference is ~100 → stroke-dasharray maps to percent.
const RADIUS = 15.9155

const clamped = computed(() =>
  props.percent === null ? 0 : Math.max(0, Math.min(100, props.percent)),
)

const centerLabel = computed(() =>
  props.percent === null ? "—" : `${props.percent.toFixed(1)} %`,
)

// The ring is the ONLY element carrying a tone color; the track carries a
// separate static muted color. Never mix static + conditional text-color on
// one element (stylesheet order, not class order, would pick the winner).
const ringColor = computed(() => {
  const p = clamped.value
  if (props.variant === "health") {
    if (p >= 100) return "text-emerald-500"
    if (p > 0) return "text-amber-500"
    return "text-rose-500"
  }
  if (p >= 90) return "text-rose-500"
  if (p >= 70) return "text-amber-500"
  return "text-sky-500"
})

// String tag so global RouterLink registration (and test stubs) resolve it;
// a native <section> when the card is not a link.
const rootTag = computed(() => (props.to === undefined ? "section" : "router-link"))
</script>

<template>
  <component
    :is="rootTag"
    :to="to"
    class="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
    :class="
      to !== undefined
        ? 'transition-colors hover:border-sky-400 hover:bg-slate-50 dark:hover:border-sky-500 dark:hover:bg-slate-800'
        : ''
    "
  >
    <div class="min-w-0">
      <h3 class="text-sm font-semibold">{{ title }}</h3>
      <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">{{ detail }}</p>
    </div>
    <div class="relative h-20 w-20 shrink-0">
      <svg viewBox="0 0 36 36" class="h-full w-full -rotate-90">
        <circle
          class="text-slate-200 dark:text-slate-700"
          :cx="18"
          :cy="18"
          :r="RADIUS"
          fill="none"
          stroke="currentColor"
          stroke-width="3.4"
        />
        <circle
          v-if="percent !== null && clamped > 0"
          :class="ringColor"
          :cx="18"
          :cy="18"
          :r="RADIUS"
          fill="none"
          stroke="currentColor"
          stroke-width="3.4"
          stroke-linecap="round"
          :stroke-dasharray="`${clamped} ${100 - clamped}`"
        />
      </svg>
      <div class="absolute inset-0 grid place-items-center">
        <span class="text-sm font-semibold tabular-nums">{{ centerLabel }}</span>
      </div>
    </div>
  </component>
</template>
