import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clearMetricsCacheContext, getMetricsBuffer } from "@/utils/metricsCache"

// Every scope key in production is context-prefixed (`<ctx>:pod:<uid>:cpu`), so
// the tests use that shape too — and isolate the way the app does, by clearing
// the contexts they wrote to. Any new test here must key under one of these two
// contexts, or its leftovers will survive into the capacity tests below (which
// depend on the exact number of cached scopes).
const CTX = "ctx"
const OTHER = "other"
const key = (scope: string): string => `${CTX}:${scope}`

describe("metricsCache", () => {
  beforeEach(() => {
    clearMetricsCacheContext(CTX)
    clearMetricsCacheContext(OTHER)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns the same instance for the same key (history survives navigation)", () => {
    const a = getMetricsBuffer(key("pod:uid-1:cpu"))
    a.push(Date.now(), { total: 5 }) // within TTL of the follow-up access
    const b = getMetricsBuffer(key("pod:uid-1:cpu"))
    expect(b).toBe(a)
    expect(b.length).toBe(1)
  })

  it("keeps distinct scopes in separate buffers (no pod/node/ns mixing)", () => {
    const pod = getMetricsBuffer(key("pod:uid-1:cpu"))
    const node = getMetricsBuffer(key("node:worker-1:cpu"))
    const ns = getMetricsBuffer(key("ns:default:cpu"))
    expect(pod).not.toBe(node)
    expect(pod).not.toBe(ns)
    expect(node).not.toBe(ns)
  })

  it("keeps a buffer whose newest sample is within the TTL", () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const a = getMetricsBuffer(key("pod:uid-1:cpu"))
    a.push(Date.now(), { total: 5 })

    vi.setSystemTime(30 * 60 * 1000) // 30m later, < 1h TTL
    const b = getMetricsBuffer(key("pod:uid-1:cpu"))
    expect(b).toBe(a)
    expect(b.length).toBe(1)
  })

  it("replaces a buffer whose newest sample is older than the TTL", () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const a = getMetricsBuffer(key("pod:uid-1:cpu"))
    a.push(Date.now(), { total: 5 })

    vi.setSystemTime(61 * 60 * 1000) // 61m later, > 1h TTL
    const b = getMetricsBuffer(key("pod:uid-1:cpu"))
    expect(b).not.toBe(a)
    expect(b.length).toBe(0)
  })

  it("evicts the oldest scope beyond the capacity bound", () => {
    // MAX_SCOPES is 64. Empty buffers survive the TTL sweep, so only the
    // capacity trim can remove them — isolating the eviction under test.
    const oldest = getMetricsBuffer(key("scope:0"))
    for (let i = 1; i < 64; i++) getMetricsBuffer(key(`scope:${i}`))

    // 65th distinct scope trips eviction of the oldest (scope:0).
    getMetricsBuffer(key("scope:64"))

    const readd = getMetricsBuffer(key("scope:0"))
    expect(readd).not.toBe(oldest)
    expect(readd.length).toBe(0)
  })

  it("refreshes LRU position on access so it is not the eviction target", () => {
    const first = getMetricsBuffer(key("scope:0"))
    for (let i = 1; i < 64; i++) getMetricsBuffer(key(`scope:${i}`))

    // Re-access scope:0 -> moves to most-recent; scope:1 becomes oldest.
    getMetricsBuffer(key("scope:0"))
    // New scope trips eviction; scope:1 (now oldest) is dropped, scope:0 kept.
    getMetricsBuffer(key("scope:64"))

    expect(getMetricsBuffer(key("scope:0"))).toBe(first)
    expect(getMetricsBuffer(key("scope:1")).length).toBe(0)
  })

  // Regression: capacity eviction used pure bind-order LRU, so a chart that
  // kept receiving samples (rank fixed at bind time) was evicted before
  // fresher-bound but stale scopes.
  it("capacity eviction keeps an actively-updated buffer over stale ones", () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const active = getMetricsBuffer(key("scope:0")) // earliest bind order
    for (let i = 1; i < 64; i++) {
      getMetricsBuffer(key(`scope:${i}`)).push(1000, { total: 1 }) // old samples
    }

    vi.setSystemTime(30 * 60 * 1000) // within TTL of every sample above
    active.push(Date.now(), { total: 5 }) // scope:0 is the freshest

    getMetricsBuffer(key("scope:64")) // trips the capacity trim

    // The victim is the oldest-sample scope, not the oldest-bound one.
    expect(getMetricsBuffer(key("scope:0"))).toBe(active)
    expect(getMetricsBuffer(key("scope:0")).length).toBe(1)
    expect(getMetricsBuffer(key("scope:1")).length).toBe(0)
  })

  it("never evicts the buffer just created for the caller", () => {
    vi.useFakeTimers()
    vi.setSystemTime(30 * 60 * 1000)
    for (let i = 0; i < 64; i++) {
      getMetricsBuffer(key(`scope:${i}`)).push(1000, { total: 1 })
    }
    // The 65th buffer is empty (lastTimestamp null) — the eviction its own
    // creation triggers must pick a stale scope instead of the new key.
    const fresh = getMetricsBuffer(key("scope:64"))
    expect(getMetricsBuffer(key("scope:64"))).toBe(fresh)
  })

  // Ending one cluster's session must not touch another's: both keep their own
  // sessions, so wiping the wrong context throws away chart history that is
  // still being fed.
  it("clearMetricsCacheContext drops only the named context's scopes", () => {
    // Samples are stamped now, so the survivor is kept on its own merits
    // rather than being handed back stale-and-replaced by the TTL path.
    const mine = getMetricsBuffer(`${CTX}:pod:uid-1:cpu`)
    mine.push(Date.now(), { total: 5 })
    const theirs = getMetricsBuffer(`${OTHER}:pod:uid-1:cpu`)
    theirs.push(Date.now(), { total: 7 })

    clearMetricsCacheContext(CTX)

    const rebound = getMetricsBuffer(`${CTX}:pod:uid-1:cpu`)
    expect(rebound).not.toBe(mine)
    expect(rebound.length).toBe(0)
    // Same scope suffix, different cluster: untouched.
    expect(getMetricsBuffer(`${OTHER}:pod:uid-1:cpu`)).toBe(theirs)
    expect(theirs.length).toBe(1)
  })

  // A context name is a prefix, not a substring: "prod" must not take "prod-eu"
  // (nor a scope whose own text happens to start with the name) down with it.
  it("clearMetricsCacheContext does not touch a context whose name it prefixes", () => {
    const sibling = getMetricsBuffer(`${CTX}-eu:pod:uid-1:cpu`)
    sibling.push(Date.now(), { total: 5 })

    clearMetricsCacheContext(CTX)

    expect(getMetricsBuffer(`${CTX}-eu:pod:uid-1:cpu`)).toBe(sibling)
    clearMetricsCacheContext(`${CTX}-eu`) // this file's isolation contract
  })
})
