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
    /**
     * Part of the *filled* arc to paint as trouble (0..100 of the same scale as
     * `percent`), e.g. the share of capacity taken by pods in a bad state.
     */
    alertPercent?: number | null
    /** Line under `detail`, in the alert tone. Only shown with a label. */
    alertLabel?: string
    /** When set, the whole card becomes a link to this route. */
    to?: RouteLocationRaw
  }>(),
  { variant: "usage", alertPercent: null, alertLabel: undefined, to: undefined },
)

// r chosen so the circumference is ~100 → stroke-dasharray maps to percent.
const RADIUS = 15.9155

/** A few bad pods out of a cluster's capacity is a fraction of a percent; below
 *  this the arc is invisible, and the point of the segment is to be noticed. */
const MIN_ALERT_ARC = 2

const clamped = computed(() =>
  props.percent === null ? 0 : Math.max(0, Math.min(100, props.percent)),
)

// Drawn over the filled arc, so it reads as a part of it and can never claim
// more than what is filled.
const alertArc = computed(() => {
  const alert = props.alertPercent
  if (alert === null || alert <= 0) return 0
  return Math.min(clamped.value, Math.max(MIN_ALERT_ARC, alert))
})

// It sits at the *end* of the fill, continuing the arc rather than interrupting
// it: placed at the start it read as a notch cut into the ring, with the fill's
// own round cap poking out ahead of it.
const alertOffset = computed(() => -(clamped.value - alertArc.value))

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
      <p v-if="alertLabel !== undefined" class="mt-0.5 text-sm font-medium text-rose-600 dark:text-rose-400">
        {{ alertLabel }}
      </p>
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
        <!-- Trouble segment, closing the filled arc. Round cap like the fill:
             its outer cap lands exactly on the fill's own, so the ring ends in
             one clean tip and the seam between the two is a soft boundary. -->
        <circle
          v-if="alertArc > 0"
          class="text-rose-500"
          :cx="18"
          :cy="18"
          :r="RADIUS"
          fill="none"
          stroke="currentColor"
          stroke-width="3.4"
          stroke-linecap="round"
          :stroke-dasharray="`${alertArc} ${100 - alertArc}`"
          :stroke-dashoffset="alertOffset"
        />
      </svg>
      <div class="absolute inset-0 grid place-items-center">
        <span class="text-sm font-semibold tabular-nums">{{ centerLabel }}</span>
      </div>
    </div>
  </component>
</template>
