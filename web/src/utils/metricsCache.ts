import { MultiSeriesRingBuffer } from "./ringBuffer"

// Shared in-memory cache of metric series buffers keyed by scope (e.g.
// `pod:<uid>:cpu`). Not reactive — components hold a shallowRef to a buffer and
// trigger updates themselves. Not persisted: it lives for the lifetime of the
// tab and is gone after a refresh. Its purpose is to keep a chart's history
// alive across component unmounts (route/tab switches) so returning to a chart
// continues instead of starting from scratch.

const TTL_MS = 60 * 60 * 1000 // 1h — matches the widest chart range
const MAX_SCOPES = 64 // bound growth over a long session

const cache = new Map<string, MultiSeriesRingBuffer>()

// Return the shared buffer for `key`, creating one if absent. A cached buffer
// whose newest sample is older than TTL_MS is considered stale and replaced by
// a fresh empty buffer, so returning to a chart after a long absence starts
// clean instead of drawing an outdated tail.
export function getMetricsBuffer(key: string): MultiSeriesRingBuffer {
  const now = Date.now()
  const existing = cache.get(key)
  if (existing !== undefined) {
    const last = existing.lastTimestamp()
    if (last === null || now - last <= TTL_MS) {
      // Refresh LRU position.
      cache.delete(key)
      cache.set(key, existing)
      return existing
    }
  }
  const fresh = new MultiSeriesRingBuffer()
  cache.set(key, fresh)
  evict(now, key)
  return fresh
}

// Drop entries whose newest sample aged past the TTL, then trim until within
// MAX_SCOPES. The capacity victim is the entry with the oldest newest-sample
// (empty buffers first): access order alone would evict a chart that is still
// actively appending samples (its Map rank is fixed at bind time) while
// keeping recently bound but idle scopes. `protect` is the key just created
// for the caller — never evict what is about to be returned.
function evict(now: number, protect?: string): void {
  for (const [key, buffer] of cache) {
    const last = buffer.lastTimestamp()
    if (last !== null && now - last > TTL_MS) cache.delete(key)
  }
  while (cache.size > MAX_SCOPES) {
    let victim: string | undefined
    let victimLast = Infinity
    for (const [key, buffer] of cache) {
      if (key === protect) continue
      const last = buffer.lastTimestamp()
      if (last === null) {
        victim = key // empty buffer: nothing to lose
        break
      }
      if (last < victimLast) {
        victimLast = last
        victim = key
      }
    }
    if (victim === undefined) break
    cache.delete(victim)
  }
}

// Drop only one context's buffers (scope keys are prefixed `<ctx>:`). Called
// when a single cluster's session ends (401 handler, TTL guard) so a re-login
// to that cluster never shows the ended session's series while other clusters'
// still-valid sessions keep their chart history.
//
// There is deliberately no whole-cache reset: every scope belongs to some
// context, so clearing one is always the answer — a global wipe could only ever
// take out clusters whose sessions are still valid (and tests isolate by
// clearing the contexts they used, exactly like the app does).
export function clearMetricsCacheContext(context: string): void {
  const prefix = `${context}:`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}
