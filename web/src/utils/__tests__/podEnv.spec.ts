import { describe, expect, it } from "vitest"

import type { K8sObject } from "@/api/types"
import { buildEnvRows, collectEnvSourceNames, type EnvResolver, type EnvRow } from "@/utils/podEnv"

function b64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
}

const pod: K8sObject = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "web", namespace: "prod", uid: "p1" },
  spec: {
    initContainers: [{ name: "init", env: [{ name: "INIT_VAR", value: "go" }] }],
    containers: [
      {
        name: "app",
        env: [
          { name: "PLAIN", value: "hello" },
          { name: "FROM_CM", valueFrom: { configMapKeyRef: { name: "cfg", key: "host" } } },
          { name: "FROM_SECRET", valueFrom: { secretKeyRef: { name: "sec", key: "password" } } },
          { name: "NODE_NAME", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } },
          { name: "CPU_LIMIT", valueFrom: { resourceFieldRef: { resource: "limits.cpu" } } },
          { name: "MISSING_KEY", valueFrom: { configMapKeyRef: { name: "cfg", key: "nope" } } },
          { name: "SECRET_DENIED", valueFrom: { secretKeyRef: { name: "denied", key: "k" } } },
          { name: "SHARED", value: "from-env" },
        ],
        envFrom: [
          { configMapRef: { name: "cfg" } },
          { secretRef: { name: "sec" }, prefix: "S_" },
        ],
      },
    ],
  },
} as unknown as K8sObject

const resolver: EnvResolver = {
  configMaps: new Map([["cfg", { host: "db.local", SHARED: "from-cm", extra: "x" }]]),
  secrets: new Map<string, Record<string, string> | null>([
    ["sec", { password: b64("p@ss"), token: b64("tkn") }],
    ["denied", null],
  ]),
}

function byName(rows: EnvRow[], name: string): EnvRow {
  const row = rows.find((r) => r.name === name)
  if (row === undefined) throw new Error(`no env row named ${name}`)
  return row
}

describe("collectEnvSourceNames", () => {
  it("dedupes ConfigMap and Secret names across env and envFrom", () => {
    const names = collectEnvSourceNames(pod)
    expect(names.configMaps).toEqual(["cfg"])
    expect(names.secrets.sort()).toEqual(["denied", "sec"])
  })
})

describe("buildEnvRows", () => {
  const rows = buildEnvRows(pod, resolver)

  it("resolves inline, ConfigMap, Secret, field and resource sources", () => {
    expect(byName(rows, "PLAIN")).toMatchObject({ kind: "literal", value: "hello", source: { label: "inline" } })
    expect(byName(rows, "FROM_CM")).toMatchObject({
      kind: "configmap",
      value: "db.local",
      source: { ref: { kind: "ConfigMap", name: "cfg" }, key: "host" },
    })
    // Secret value stays as raw base64 — the component decodes on reveal.
    expect(byName(rows, "FROM_SECRET")).toMatchObject({
      kind: "secret",
      value: b64("p@ss"),
      source: { ref: { kind: "Secret", name: "sec" }, key: "password" },
    })
    expect(byName(rows, "NODE_NAME")).toMatchObject({ kind: "field", value: "spec.nodeName", source: { label: "fieldRef" } })
    expect(byName(rows, "CPU_LIMIT")).toMatchObject({
      kind: "field",
      value: "limits.cpu",
      source: { label: "resourceFieldRef" },
    })
  })

  it("expands envFrom sources into one row per key with the prefix (no key, ref only)", () => {
    expect(byName(rows, "host")).toMatchObject({
      kind: "configmap",
      value: "db.local",
      source: { ref: { kind: "ConfigMap", name: "cfg" } },
    })
    expect(byName(rows, "host").source.key).toBeUndefined()
    expect(byName(rows, "extra")).toMatchObject({ kind: "configmap", value: "x" })
    expect(byName(rows, "S_password")).toMatchObject({
      kind: "secret",
      value: b64("p@ss"),
      source: { ref: { kind: "Secret", name: "sec" } },
    })
    expect(byName(rows, "S_token")).toMatchObject({ kind: "secret", value: b64("tkn") })
  })

  it("lets an explicit env entry override an envFrom import of the same name", () => {
    const shared = rows.filter((r) => r.name === "SHARED")
    expect(shared).toHaveLength(1)
    expect(shared[0]).toMatchObject({ kind: "literal", value: "from-env" })
  })

  it("marks missing keys and unreadable objects instead of failing", () => {
    expect(byName(rows, "MISSING_KEY")).toMatchObject({ kind: "missing", value: "(key not found)" })
    expect(byName(rows, "SECRET_DENIED")).toMatchObject({ kind: "missing", value: "(cannot read secret)" })
  })

  it("includes init containers and tags the container type", () => {
    expect(byName(rows, "INIT_VAR")).toMatchObject({ container: "init", containerType: "init", value: "go" })
    expect(byName(rows, "PLAIN")).toMatchObject({ container: "app", containerType: "container" })
  })

  it("sorts globally by variable name", () => {
    const names = rows.map((r) => r.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })

  it("treats a bare `- name: FOO` (no value/valueFrom) as an inline empty value", () => {
    const bare: K8sObject = {
      spec: { containers: [{ name: "c", env: [{ name: "MG_AMAZON_S3_BUCKET_NAME" }] }] },
    } as unknown as K8sObject
    const out = buildEnvRows(bare, { configMaps: new Map(), secrets: new Map() })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      name: "MG_AMAZON_S3_BUCKET_NAME",
      kind: "literal",
      value: "",
      source: { label: "inline" },
    })
  })

  // A ConfigMap/Secret key name may be any of [-._a-zA-Z0-9]+, which includes
  // every Object.prototype member: an `in` lookup would report "constructor" as
  // present and render the inherited function as the variable's value.
  it("reports a key named after an Object.prototype member as not found", () => {
    const proto: K8sObject = {
      spec: {
        containers: [
          {
            name: "c",
            env: [
              { name: "A", valueFrom: { configMapKeyRef: { name: "cfg", key: "constructor" } } },
              { name: "B", valueFrom: { configMapKeyRef: { name: "cfg", key: "toString" } } },
            ],
          },
        ],
      },
    } as unknown as K8sObject
    const out = buildEnvRows(proto, {
      configMaps: new Map([["cfg", { host: "db.local" }]]),
      secrets: new Map(),
    })
    for (const row of out) {
      expect(row).toMatchObject({ kind: "missing", value: "(key not found)" })
    }
  })

  it("emits a single placeholder row when an envFrom source is unreadable", () => {
    const denied: K8sObject = {
      spec: { containers: [{ name: "c", envFrom: [{ configMapRef: { name: "gone" } }] }] },
    } as unknown as K8sObject
    const out = buildEnvRows(denied, {
      configMaps: new Map([["gone", null]]),
      secrets: new Map(),
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      name: "*",
      kind: "missing",
      value: "(cannot read configmap)",
      source: { ref: { kind: "ConfigMap", name: "gone" } },
    })
  })
})
