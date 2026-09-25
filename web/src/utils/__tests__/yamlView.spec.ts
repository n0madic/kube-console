import { describe, expect, it } from "vitest"
import { parse } from "yaml"

import type { K8sObject } from "@/api/types"
import { encodeBase64Utf8 } from "@/utils/base64"
import {
  encodeSecretYaml,
  parseManifest,
  toDecodedSecretYaml,
  toEditableYaml,
  toYaml,
} from "@/utils/yamlView"

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

function secretWith(data: Record<string, string> | undefined): K8sObject {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "db", namespace: "prod", uid: "s1", resourceVersion: "7" },
    ...(data === undefined ? {} : { data }),
    type: "Opaque",
  }
}

const BINARY = "//4AAQLI" // 0xff 0xfe 0x00 0x01 0x02 0xc8: not UTF-8

describe("toDecodedSecretYaml / encodeSecretYaml", () => {
  // Every shape YAML has an opinion about: block scalars and their chomping,
  // quoting of strings that would otherwise read as numbers/booleans/null,
  // folding of long lines, significant whitespace.
  const values: Record<string, string> = {
    pem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    spaces: "  padded value  ",
    empty: "",
    number: "123",
    octal: "0777",
    bool: "true",
    nullish: "null",
    unicode: "пароль ✓ 密码",
    crlf: "line1\r\nline2\r\n",
    control: "a\u0000b\tc\u001b[0m",
    long: "x".repeat(60) + " " + "y".repeat(60) + " " + "z".repeat(60),
    multiline: "first\nsecond",
    trailing: "keep\n\n",
    bom: "\ufeffkey=value",
  }

  it("round-trips every value byte for byte", () => {
    const data = Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, encodeBase64Utf8(v)]),
    )
    const decoded = toDecodedSecretYaml(secretWith({ ...data, bin: BINARY }))
    const back = parse(encodeSecretYaml(decoded)) as K8sObject
    expect(back.data).toEqual({ ...data, bin: BINARY })
  })

  it("shows text as plain text and binary values as !!binary base64", () => {
    const text = toDecodedSecretYaml(
      secretWith({ password: encodeBase64Utf8("s3cret"), bin: BINARY }),
    )
    expect(text).toContain("password: s3cret")
    expect(text).toMatch(/bin: !!binary/)
    expect(text).not.toContain(encodeBase64Utf8("s3cret"))
    // Still the editable projection: server-managed fields are gone.
    expect(text).not.toContain("resourceVersion")
    expect(text).not.toContain("uid")
  })

  it("keeps data where it was in the document", () => {
    const text = toDecodedSecretYaml(secretWith({ a: encodeBase64Utf8("1") }))
    expect(Object.keys(parse(text) as object)).toEqual(["apiVersion", "kind", "metadata", "data", "type"])
    const encoded = encodeSecretYaml(text)
    expect(Object.keys(parse(encoded) as object)).toEqual(["apiVersion", "kind", "metadata", "data", "type"])
  })

  it("re-encodes an edited value and a hand-written !!binary one", () => {
    const edited = [
      "apiVersion: v1",
      "kind: Secret",
      "metadata:",
      "  name: db",
      "data:",
      "  password: new-pass",
      "  raw: !!binary AAEC",
    ].join("\n")
    const back = parse(encodeSecretYaml(edited)) as K8sObject
    expect(back.data).toEqual({ password: encodeBase64Utf8("new-pass"), raw: "AAEC" })
  })

  // A key named __proto__ is a valid Secret key; assigning it on a plain
  // object would hit the prototype setter and drop it.
  it("keeps a __proto__ key", () => {
    const data = JSON.parse(`{"__proto__": "${encodeBase64Utf8("x")}"}`) as Record<string, string>
    const back = parse(encodeSecretYaml(toDecodedSecretYaml(secretWith(data)))) as Record<string, unknown>
    expect(Object.keys(back.data as object)).toEqual(["__proto__"])
  })

  it("leaves a Secret without data alone", () => {
    const text = toDecodedSecretYaml(secretWith(undefined))
    expect(text).toBe(toEditableYaml(secretWith(undefined)))
    expect(parse(encodeSecretYaml(text))).toEqual(parse(text))
  })

  it.each([
    ["an unquoted number", "  port: 5432", "data.port"],
    ["an unquoted boolean", "  flag: true", "data.flag"],
    ["an empty value", "  empty:", "data.empty"],
    ["a nested map", "  nested:\n    a: b", "data.nested"],
  ])("refuses %s instead of coercing it", (_, line, key) => {
    const text = `apiVersion: v1\nkind: Secret\ndata:\n${line}\n`
    expect(() => encodeSecretYaml(text)).toThrow(`${key} must be a string`)
  })

  it("refuses data that is not a map, and a manifest that is not an object", () => {
    expect(() => encodeSecretYaml("kind: Secret\ndata: [a, b]\n")).toThrow("data must be a map")
    expect(() => encodeSecretYaml("- a\n")).toThrow("must be a YAML object")
  })
})
