import { describe, expect, it } from "vitest"
import { parse } from "yaml"

import type { K8sObject } from "@/api/types"
import { parseManifest, toEditableYaml, toYaml } from "@/utils/yamlView"

const serverObject: K8sObject = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: {
    name: "web",
    namespace: "default",
    labels: { app: "web" },
    uid: "u1",
    resourceVersion: "12345",
    creationTimestamp: "2026-07-20T10:00:00Z",
    generation: 3,
    managedFields: [{ manager: "kubectl" }],
  } as K8sObject["metadata"],
  spec: { replicas: 2 },
  status: { readyReplicas: 2 },
}

describe("toYaml", () => {
  it("serializes an object to YAML that parses back unchanged", () => {
    const text = toYaml({ a: 1, b: ["x", "y"] })
    expect(parse(text)).toEqual({ a: 1, b: ["x", "y"] })
  })
})

describe("toEditableYaml", () => {
  it("strips server-managed fields but keeps identity, labels and spec", () => {
    const roundTrip = parse(toEditableYaml(serverObject)) as K8sObject
    expect(roundTrip.status).toBeUndefined()
    expect(roundTrip.metadata?.managedFields).toBeUndefined()
    expect(roundTrip.metadata?.resourceVersion).toBeUndefined()
    expect(roundTrip.metadata?.uid).toBeUndefined()
    expect(roundTrip.metadata?.creationTimestamp).toBeUndefined()
    expect((roundTrip.metadata as Record<string, unknown>).generation).toBeUndefined()

    expect(roundTrip.metadata?.name).toBe("web")
    expect(roundTrip.metadata?.namespace).toBe("default")
    expect(roundTrip.metadata?.labels).toEqual({ app: "web" })
    expect(roundTrip.spec).toEqual({ replicas: 2 })
  })

  it("does not mutate the source object", () => {
    toEditableYaml(serverObject)
    expect(serverObject.status).toBeDefined()
    expect(serverObject.metadata?.resourceVersion).toBe("12345")
  })
})

describe("parseManifest", () => {
  it("extracts the object, name and namespace", () => {
    const parsed = parseManifest(
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n  namespace: prod\n",
    )
    expect(parsed.name).toBe("cfg")
    expect(parsed.namespace).toBe("prod")
    expect(parsed.object.kind).toBe("ConfigMap")
  })

  it("leaves namespace undefined for cluster-scoped manifests", () => {
    const parsed = parseManifest("apiVersion: v1\nkind: Namespace\nmetadata:\n  name: prod\n")
    expect(parsed.namespace).toBeUndefined()
  })

  it("rejects a manifest that is not a YAML object", () => {
    expect(() => parseManifest("just a string")).toThrow(/must be a YAML object/)
  })

  it("rejects a manifest without metadata.name (required for apply)", () => {
    expect(() => parseManifest("apiVersion: v1\nkind: ConfigMap\nmetadata: {}\n")).toThrow(
      /metadata\.name is required/,
    )
    expect(() =>
      parseManifest('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ""\n'),
    ).toThrow(/metadata\.name is required/)
  })
})
