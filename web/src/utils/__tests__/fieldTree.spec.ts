import { describe, expect, it } from "vitest"

import { buildFieldTree, humanizeKey, itemTitle } from "@/utils/fieldTree"
import type { ChipsNode, GroupNode, ItemsNode, LeafNode, TableNode } from "@/utils/fieldTree"

describe("buildFieldTree depth guard", () => {
  it("renders a deeply nested value as a JSON leaf instead of recursing forever", () => {
    // Build a chain deeper than MAX_DEPTH (32).
    let deep: Record<string, unknown> = { end: "value" }
    for (let i = 0; i < 60; i++) deep = { nested: deep }
    // Should not throw (no stack overflow) and should produce a finite tree.
    const tree = buildFieldTree({ root: deep })
    expect(tree).toHaveLength(1)
    expect(tree[0]?.key).toBe("root")
  })
})

describe("humanizeKey", () => {
  it("splits camelCase and capitalizes", () => {
    expect(humanizeKey("restartPolicy")).toBe("Restart Policy")
    expect(humanizeKey("terminationGracePeriodSeconds")).toBe("Termination Grace Period Seconds")
    expect(humanizeKey("replicas")).toBe("Replicas")
  })

  it("keeps and uppercases acronyms", () => {
    expect(humanizeKey("dnsPolicy")).toBe("DNS Policy")
    expect(humanizeKey("hostIP")).toBe("Host IP")
    expect(humanizeKey("podCIDRs")).toBe("Pod CIDRs")
    expect(humanizeKey("clusterIPs")).toBe("Cluster IPs")
    expect(humanizeKey("ipFamilies")).toBe("IP Families")
  })
})

describe("buildFieldTree", () => {
  it("returns [] for non-object values", () => {
    expect(buildFieldTree(undefined)).toEqual([])
    expect(buildFieldTree("plain")).toEqual([])
    expect(buildFieldTree([1, 2])).toEqual([])
  })

  it("renders scalars as leaves preserving key order", () => {
    const nodes = buildFieldTree({ replicas: 3, paused: true, note: null })
    expect(nodes.map((n) => n.type)).toEqual(["leaf", "leaf", "leaf"])
    const [replicas, paused, note] = nodes as LeafNode[]
    expect(replicas?.label).toBe("Replicas")
    expect(replicas?.text).toBe("3")
    expect(paused?.text).toBe("true")
    expect(note?.text).toBe("null")
  })

  it("adds an age suffix to timestamp leaves", () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString()
    const [leaf] = buildFieldTree({ startTime: recent }) as LeafNode[]
    expect(leaf?.text).toBe(recent)
    expect(leaf?.suffix).toMatch(/\(\d+m ago\)$/)
  })

  it("labels future timestamps with 'in' instead of a clamped '0s ago'", () => {
    const future = new Date(Date.now() + 90 * 60_000).toISOString()
    const [leaf] = buildFieldTree({ renewalTime: future }) as LeafNode[]
    expect(leaf?.suffix).toMatch(/^\(in \S+\)$/)
    expect(leaf?.suffix).not.toContain("ago")
  })

  it("color-codes status-bearing keys only", () => {
    const [phase, message] = buildFieldTree({
      phase: "Failed",
      message: "error while pulling",
    }) as LeafNode[]
    expect(phase?.statusClass).toContain("text-red")
    expect(message?.statusClass).toBeNull()
  })

  it("marks long and multiline values as long", () => {
    const nodes = buildFieldTree({
      caBundle: "A".repeat(300),
      script: "line1\nline2",
      short: "ok",
    }) as LeafNode[]
    expect(nodes[0]?.long).toBe(true)
    expect(nodes[1]?.long).toBe(true)
    expect(nodes[2]?.long).toBe(false)
  })

  it("renders scalar arrays as chips and empty arrays as [] leaf", () => {
    const [args, empty] = buildFieldTree({ args: ["--v=2", "serve"], finalizers: [] })
    expect(args?.type).toBe("chips")
    expect((args as ChipsNode).chips.map((c) => c.text)).toEqual(["--v=2", "serve"])
    expect(empty?.type).toBe("leaf")
    expect((empty as LeafNode).text).toBe("[]")
  })

  it("marks long chip values as long", () => {
    const [node] = buildFieldTree({ args: [`--config=${"x".repeat(300)}`, "serve"] })
    const chips = (node as ChipsNode).chips
    expect(chips[0]?.long).toBe(true)
    expect(chips[1]?.long).toBe(false)
  })

  it("renders selector-like string maps as k=v chips", () => {
    const [node] = buildFieldTree({ nodeSelector: { disktype: "ssd", zone: "a" } })
    expect(node?.type).toBe("chips")
    expect((node as ChipsNode).chips.map((c) => c.text)).toEqual(["disktype=ssd", "zone=a"])
  })

  it("keeps non-selector string maps as nested groups", () => {
    const [node] = buildFieldTree({ capacity: { cpu: "8", memory: "16Gi" } })
    expect(node?.type).toBe("group")
    const children = (node as GroupNode).children as LeafNode[]
    expect(children.map((c) => c.label)).toEqual(["CPU", "Memory"])
  })

  it("renders flat homogeneous object arrays as a table", () => {
    const [node] = buildFieldTree({
      ports: [
        { name: "http", port: 80, protocol: "TCP" },
        { name: "https", port: 443, protocol: "TCP" },
      ],
    })
    expect(node?.type).toBe("table")
    const table = node as TableNode
    expect(table.columns).toEqual(["Name", "Port", "Protocol"])
    expect(table.rows[1]?.map((c) => c.text)).toEqual(["https", "443", "TCP"])
  })

  it("marks long table cells as long", () => {
    const [node] = buildFieldTree({
      env: [
        { name: "HOST", value: "https://example.com" },
        { name: "RSA_KEY", value: "K".repeat(2000) },
      ],
    }) as TableNode[]
    expect(node?.type).toBe("table")
    expect(node?.rows[0]?.[1]?.long).toBe(false)
    expect(node?.rows[1]?.[1]?.long).toBe(true)
  })

  it("renders nested object arrays as titled items", () => {
    const [node] = buildFieldTree({
      containerStatuses: [
        { name: "app", ready: true, state: { running: { startedAt: "2026-01-01T00:00:00Z" } } },
        { name: "sidecar", ready: false, state: { waiting: { reason: "CrashLoopBackOff" } } },
      ],
    })
    expect(node?.type).toBe("items")
    const items = node as ItemsNode
    expect(items.items.map((i) => i.title)).toEqual(["app", "sidecar"])
    expect(items.items[0]?.children.some((c) => c.type === "group")).toBe(true)
  })

  it("computes leafCount recursively for auto-collapse", () => {
    const [node] = buildFieldTree({
      template: { spec: { a: 1, b: 2 }, meta: { c: 3 } },
    }) as GroupNode[]
    expect(node?.leafCount).toBe(3)
  })

  it("skips top-level keys via skipKeys", () => {
    const nodes = buildFieldTree(
      { conditions: [{ type: "Ready" }], phase: "Running" },
      { skipKeys: ["conditions"] },
    )
    expect(nodes).toHaveLength(1)
    expect((nodes[0] as LeafNode).label).toBe("Phase")
  })
})

describe("itemTitle", () => {
  it("prefers well-known title keys and falls back to index", () => {
    expect(itemTitle({ name: "app", image: "nginx" }, 0)).toBe("app")
    expect(itemTitle({ type: "SendEvents" }, 1)).toBe("SendEvents")
    expect(itemTitle({ image: "nginx" }, 2)).toBe("#3")
  })
})

describe("object references", () => {
  function nameLeaf(value: Record<string, unknown>): LeafNode {
    const group = buildFieldTree(value)[0] as GroupNode
    return group.children.find((c) => c.key === "name") as LeafNode
  }

  it("marks the name leaf of any kind+name record (shape, not kind)", () => {
    expect(
      nameLeaf({
        involvedObject: { kind: "Pod", apiVersion: "v1", namespace: "prod", name: "nginx" },
      }).ref,
    ).toEqual({
      apiVersion: "v1",
      apiGroup: undefined,
      kind: "Pod",
      name: "nginx",
      namespace: "prod",
    })
    // RBAC-style: a group, no version, no namespace of its own.
    expect(
      nameLeaf({ roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "reader" } })
        .ref,
    ).toEqual({
      apiVersion: undefined,
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: "reader",
      namespace: undefined,
    })
  })

  it("marks nothing when kind or name is missing", () => {
    expect(nameLeaf({ port: { name: "http", protocol: "TCP" } }).ref).toBeUndefined()
    const group = buildFieldTree({ ref: { kind: "Pod", uid: "u1" } })[0] as GroupNode
    expect(group.children.some((c) => c.type === "leaf" && c.ref !== undefined)).toBe(false)
  })

  it("marks refs inside object arrays too (RBAC subjects)", () => {
    const items = buildFieldTree({
      subjects: [{ kind: "ServiceAccount", name: "deployer", namespace: "ci", extra: {} }],
    })[0] as ItemsNode
    const leaf = items.items[0]!.children.find((c) => c.key === "name") as LeafNode
    expect(leaf.ref?.kind).toBe("ServiceAccount")
    expect(leaf.ref?.namespace).toBe("ci")
  })
})
