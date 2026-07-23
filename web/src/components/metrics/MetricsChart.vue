<script setup lang="ts">
import uPlot from "uplot"
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"

import { seriesStats } from "@/utils/metricsStats"
import { timeAxisLabels } from "@/utils/timeAxis"
import { formatBytes, formatCpu } from "@/utils/units"

const props = defineProps<{
  title: string
  unit: "cpu" | "memory"
  labels: string[]
  data: Array<Array<number | null>>
}>()

// Validated categorical palettes (dataviz six-checks), fixed slot order.
const LIGHT_PALETTE = ["#2a78d6", "#008300", "#e87ba4", "#eda100", "#1baf7a", "#eb6834"]
const DARK_PALETTE = ["#3987e5", "#008300", "#d55181", "#c98500", "#199e70", "#d95926"]

/** Tooltip surface colors per theme (elevated above the chart card). */
const LIGHT_TIP = { bg: "#ffffff", border: "#e2e8f0", text: "#1e293b", muted: "#64748b" }
const DARK_TIP = { bg: "#1e293b", border: "#334155", text: "#f1f5f9", muted: "#94a3b8" }

/** Semi-transparent area fill below a series line. */
function fillColor(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// uPlot's default axis font, mirrored here so tick labels can be measured.
const AXIS_FONT =
  '12px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
/** Tick text → axis edge: uPlot's default axis gap plus a little breathing room. */
const Y_AXIS_GAP = 12
const Y_AXIS_MIN = 52

let measureCtx: CanvasRenderingContext2D | null | undefined

/** Width of a tick label in CSS px; falls back to an estimate without canvas (jsdom). */
function labelWidth(text: string): number {
  if (measureCtx === undefined) {
    // jsdom has no 2d context and returns undefined rather than null.
    measureCtx = document.createElement("canvas").getContext("2d") ?? null
    if (measureCtx !== null) measureCtx.font = AXIS_FONT
  }
  if (measureCtx === null) return text.length * 7
  return measureCtx.measureText(text).width
}

/**
 * Y-axis width. The tick labels are formatted values whose width depends on the
 * cluster's scale ("820 mCPU" vs "1234.00 cores"), so a fixed size clipped the
 * widest ones. uPlot calls this on every redraw with the current tick strings —
 * and once with `null` before any exist.
 */
function yAxisSize(values: string[] | null): number {
  if (values === null || values.length === 0) return Y_AXIS_MIN
  let widest = 0
  for (const v of values) widest = Math.max(widest, labelWidth(v))
  return Math.max(Y_AXIS_MIN, Math.ceil(widest) + Y_AXIS_GAP)
}

const host = ref<HTMLElement | null>(null)
let chart: uPlot | null = null
let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null

const isDark = () => document.documentElement.classList.contains("dark")
// The .dark class on <html> is not a Vue reactive dependency, so mirror it into
// a ref (kept live by a MutationObserver) — otherwise a theme toggle would not
// rebuild the chart palette.
const dark = ref(isDark())

function colorFor(i: number): string {
  const palette = dark.value ? DARK_PALETTE : LIGHT_PALETTE
  return palette[i % palette.length] as string
}

function formatValue(value: number | null): string {
  if (value === null) return ""
  return props.unit === "cpu" ? formatCpu(value) : formatBytes(value)
}

/** Stat display: em-dash for a missing value. */
function formatStat(value: number | null): string {
  return value === null ? "—" : formatValue(value)
}

const hasData = computed(() => props.data[0] !== undefined && props.data[0].length > 0)

// min/avg/max per series over the currently displayed period (props.data is
// already windowed to the selected range upstream). colorFor() reads `dark`, so
// the swatch stays in sync with a theme toggle.
const stats = computed(() =>
  props.labels.map((label, i) => ({
    label,
    color: colorFor(i),
    ...seriesStats(props.data, i),
  })),
)

const seriesKey = computed(() => `${dark.value ? "dark" : "light"}:${props.labels.join("|")}`)

/**
 * Hover tooltip: lists every series value at the crosshair X, with a
 * timestamp header. Values lead, labels follow (dataviz interaction rules);
 * series names go in via textContent (they come from container names — never
 * innerHTML). Styled inline from the theme captured at build time so no global
 * CSS leaks and the tooltip is dark-mode correct.
 */
function tooltipPlugin(palette: string[]): uPlot.Plugin {
  const tip = dark.value ? DARK_TIP : LIGHT_TIP
  let el: HTMLDivElement | null = null

  const hide = () => {
    if (el !== null) el.style.display = "none"
  }

  return {
    hooks: {
      init: (u: uPlot) => {
        el = document.createElement("div")
        Object.assign(el.style, {
          position: "absolute",
          top: "0",
          left: "0",
          display: "none",
          pointerEvents: "none",
          zIndex: "10",
          padding: "6px 8px",
          borderRadius: "6px",
          fontSize: "12px",
          lineHeight: "1.4",
          whiteSpace: "nowrap",
          background: tip.bg,
          border: `1px solid ${tip.border}`,
          color: tip.text,
          boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        })
        u.over.appendChild(el)
        u.over.addEventListener("mouseleave", hide)
      },
      setCursor: (u: uPlot) => {
        if (el === null) return
        const idx = u.cursor.idx
        const left = u.cursor.left ?? -1
        const top = u.cursor.top ?? -1
        if (idx === null || idx === undefined || left < 0 || top < 0) {
          hide()
          return
        }

        el.replaceChildren()
        const tsSec = u.data[0][idx]
        const header = document.createElement("div")
        Object.assign(header.style, { color: tip.muted, marginBottom: "4px" })
        header.textContent =
          tsSec === undefined || tsSec === null ? "" : new Date(tsSec * 1000).toLocaleTimeString()
        el.appendChild(header)

        for (let s = 1; s < u.data.length; s++) {
          const row = document.createElement("div")
          Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px" })

          const key = document.createElement("span")
          Object.assign(key.style, {
            width: "12px",
            height: "3px",
            borderRadius: "2px",
            flexShrink: "0",
            background: palette[(s - 1) % palette.length] as string,
          })

          const val = document.createElement("span")
          Object.assign(val.style, { fontWeight: "600", fontVariantNumeric: "tabular-nums" })
          val.textContent = formatStat(u.data[s]?.[idx] ?? null)

          const name = document.createElement("span")
          name.style.color = tip.muted
          const label = u.series[s]?.label
          name.textContent = typeof label === "string" ? label : ""

          row.append(key, val, name)
          el.appendChild(row)
        }

        el.style.display = "block"
        const pad = 12
        const overW = u.over.clientWidth
        let x = left + pad
        if (x + el.offsetWidth > overW) x = left - el.offsetWidth - pad
        if (x < 0) x = 0
        let y = top - el.offsetHeight - pad
        if (y < 0) y = top + pad
        el.style.transform = `translate(${x}px, ${y}px)`
      },
      destroy: () => {
        el?.remove()
        el = null
      },
    },
  }
}

function buildChart(): void {
  destroyChart()
  const el = host.value
  if (el === null) return
  const palette = dark.value ? DARK_PALETTE : LIGHT_PALETTE
  const axisColor = dark.value ? "#c3c2b7" : "#52514e"
  const gridColor = dark.value ? "rgba(195,194,183,0.12)" : "rgba(82,81,78,0.12)"

  // With several overlapping series keep the fill lighter so lines stay
  // readable.
  const fillAlpha = props.labels.length > 1 ? 0.08 : 0.15
  const series: uPlot.Series[] = [
    {},
    ...props.labels.map((label, i) => ({
      label,
      stroke: palette[i % palette.length],
      fill: fillColor(palette[i % palette.length] as string, fillAlpha),
      width: 2,
      points: { show: false },
    })),
  ]

  chart = new uPlot(
    {
      width: Math.max(el.clientWidth, 320),
      height: 220,
      series,
      cursor: { drag: { x: false, y: false } },
      // Current values live in the hover tooltip; the bottom row shows
      // min/avg/max instead, so the built-in legend is disabled.
      legend: { show: false },
      plugins: [tooltipPlugin(palette)],
      scales: { x: { time: true } },
      axes: [
        {
          stroke: axisColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { show: false },
          // Splits are in seconds (uPlot's default time unit); locale-formatted
          // here because uPlot's own stamps are US-only.
          values: (_u, splits, _idx, _space, incr) => timeAxisLabels(splits, incr),
        },
        {
          stroke: axisColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { show: false },
          size: (_u, values) => yAxisSize(values as string[] | null),
          values: (_u, ticks) => ticks.map((v) => formatValue(v)),
        },
      ],
    },
    props.data as uPlot.AlignedData,
    el,
  )

  resizeObserver = new ResizeObserver(() => {
    if (chart !== null && el.clientWidth > 0) {
      chart.setSize({ width: el.clientWidth, height: 220 })
    }
  })
  resizeObserver.observe(el)
}

function destroyChart(): void {
  resizeObserver?.disconnect()
  resizeObserver = null
  chart?.destroy()
  chart = null
}

onMounted(() => {
  buildChart()
  themeObserver = new MutationObserver(() => {
    dark.value = isDark()
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  })
})
onBeforeUnmount(() => {
  themeObserver?.disconnect()
  themeObserver = null
  destroyChart()
})

// Series set or theme changed: rebuild; data changed: update in place.
watch(seriesKey, buildChart)
watch(
  () => props.data,
  (data) => {
    chart?.setData(data as uPlot.AlignedData)
  },
)
</script>

<template>
  <section class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
    <div class="mb-2 flex items-baseline justify-between">
      <h3 class="text-sm font-semibold">{{ title }}</h3>
      <span class="text-xs uppercase tracking-wide text-slate-400">Live session metrics</span>
    </div>
    <p v-if="!hasData" class="py-10 text-center text-sm text-slate-400">Waiting for the first sample...</p>
    <div v-show="hasData">
      <div ref="host" class="w-full"></div>
      <div class="mt-3 space-y-1 border-t border-slate-100 pt-3 dark:border-slate-800">
        <div v-for="s in stats" :key="s.label" class="flex items-center gap-2 text-xs">
          <span class="h-[3px] w-4 shrink-0 rounded-full" :style="{ backgroundColor: s.color }"></span>
          <span class="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300">{{ s.label }}</span>
          <span class="flex shrink-0 items-center gap-3 tabular-nums text-slate-400 dark:text-slate-500">
            <span>min <span class="text-slate-700 dark:text-slate-200">{{ formatStat(s.min) }}</span></span>
            <span>avg <span class="text-slate-700 dark:text-slate-200">{{ formatStat(s.avg) }}</span></span>
            <span>max <span class="text-slate-700 dark:text-slate-200">{{ formatStat(s.max) }}</span></span>
          </span>
        </div>
      </div>
    </div>
  </section>
</template>
