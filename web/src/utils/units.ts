// Formatting helpers: CPU (mCPU/cores), memory (KiB/MiB/GiB), ages.

export function formatCpu(nanoCores: number): string {
  const milli = nanoCores / 1_000_000
  if (milli < 1000) {
    return `${milli < 10 ? milli.toFixed(1) : Math.round(milli)} mCPU`
  }
  const cores = nanoCores / 1_000_000_000
  return `${cores.toFixed(2)} cores`
}

// Kubernetes resource.Quantity suffixes → multiplier in base units.
const QUANTITY_SUFFIXES: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
}

/**
 * Parse a Kubernetes resource.Quantity string to a plain number in base units
 * (cores for CPU, bytes for memory, a bare count for pods). Covers the binary
 * (Ki/Mi/Gi/…) and decimal SI (m/k/M/G/…) suffixes that appear in node
 * `.status.allocatable`. Returns NaN for missing or unparseable input.
 */
export function parseQuantity(value: string | number | undefined): number {
  if (typeof value === "number") return value
  if (value === undefined || value === "") return NaN
  const match = /^(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)(\D*)$/.exec(value.trim())
  if (match === null) return NaN
  const num = Number(match[1])
  const mult = QUANTITY_SUFFIXES[match[2] as keyof typeof QUANTITY_SUFFIXES]
  if (mult === undefined || Number.isNaN(num)) return NaN
  return num * mult
}

/** Compact core count: integers as-is, fractions to 2 decimals ("8", "0.82"). */
export function formatCores(cores: number): string {
  return Number.isInteger(cores) ? String(cores) : cores.toFixed(2)
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const

export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`
}

// Short magnitude for a non-negative duration in seconds: "45s", "3h20m",
// "90d", "1y30d". Shared by formatAge and formatRelativeAge.
function formatDurationShort(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  let minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  minutes %= 60
  if (hours < 24) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 365) return `${days}d`
  return `${Math.floor(days / 365)}y${days % 365 > 0 ? `${days % 365}d` : ""}`
}

export function formatAge(timestamp: string | undefined, now: Date = new Date()): string {
  if (timestamp === undefined || timestamp === "") return ""
  const then = new Date(timestamp).getTime()
  if (Number.isNaN(then)) return ""
  return formatDurationShort(Math.max(0, Math.floor((now.getTime() - then) / 1000)))
}

// Relative phrase with direction: "5h ago" for past, "in 90d" for future.
// Unlike formatAge this does not clamp future timestamps (e.g. cert renewal
// or expiry times) to a misleading "0s ago". Empty for missing/invalid input.
export function formatRelativeAge(timestamp: string | undefined, now: Date = new Date()): string {
  if (timestamp === undefined || timestamp === "") return ""
  const then = new Date(timestamp).getTime()
  if (Number.isNaN(then)) return ""
  const delta = Math.floor((now.getTime() - then) / 1000)
  return delta < 0 ? `in ${formatDurationShort(-delta)}` : `${formatDurationShort(delta)} ago`
}
