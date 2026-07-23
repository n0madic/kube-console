// uPlot's built-in time axis is hardcoded to US formats ("7:51pm", "7/21/26")
// and ignores the browser's regional settings, so chart ticks are formatted
// here with Intl instead: 24h vs am/pm and the date order then follow the
// user's locale (the tooltip already uses toLocaleTimeString).

// Locale is resolved once at load — changing it takes a reload anyway.
const HOUR_MIN = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const HOUR_MIN_SEC = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
})
const DATE = new Intl.DateTimeFormat(undefined, {
  year: "2-digit",
  month: "numeric",
  day: "numeric",
})

/**
 * Tick labels for a time x-axis, from split timestamps in **seconds** and the
 * tick interval uPlot settled on. Seconds are shown only when ticks are closer
 * together than a minute. The date is appended as a second line (uPlot splits
 * labels on "\n") for the first tick and on every day rollover — same idea as
 * uPlot's own axis, so a chart spanning midnight stays readable.
 */
export function timeAxisLabels(splitsSec: number[], incrSec: number): string[] {
  const time = incrSec < 60 ? HOUR_MIN_SEC : HOUR_MIN
  let prevDay = ""
  return splitsSec.map((sec) => {
    const at = new Date(sec * 1000)
    const day = DATE.format(at)
    const label = time.format(at)
    if (day === prevDay) return label
    prevDay = day
    return `${label}\n${day}`
  })
}
