// Flatten every environment variable a Pod's containers declare — inline
// values, valueFrom refs (ConfigMap/Secret/field/resource) and bulk envFrom
// imports — into one list. ConfigMap/Secret values are resolved from lookup
// maps the caller fetches. Follows kubectl precedence: envFrom sources apply
// first (later overriding earlier), then env entries override envFrom.

import type { K8sObject } from "@/api/types"

export type EnvValueKind = "literal" | "configmap" | "secret" | "field" | "missing"
export type ContainerType = "init" | "container" | "ephemeral"

/** Backing object a value comes from — the caller turns this into a link. */
export interface EnvSourceRef {
  kind: "ConfigMap" | "Secret"
  name: string
}

export interface EnvSource {
  /** Present when the value is backed by a ConfigMap/Secret (link target). */
  ref?: EnvSourceRef
  /** Specific key within that object; absent for a bulk envFrom import. */
  key?: string
  /** Text label for non-object sources: "inline", "fieldRef", "resourceFieldRef". */
  label?: string
}

export interface EnvRow {
  container: string
  containerType: ContainerType
  name: string
  kind: EnvValueKind
  /** Display text; for kind "secret" this is the raw base64 (decode on reveal). */
  value: string
  source: EnvSource
}

// Referenced-object data by name; null means the object could not be read
// (forbidden/not-found/error). Secret records hold base64 values.
export interface EnvResolver {
  configMaps: Map<string, Record<string, string> | null>
  secrets: Map<string, Record<string, string> | null>
}

interface KeyRef {
  name?: string
  key?: string
  optional?: boolean
}

interface EnvVar {
  name?: string
  value?: string
  valueFrom?: {
    configMapKeyRef?: KeyRef
    secretKeyRef?: KeyRef
    fieldRef?: { fieldPath?: string }
    resourceFieldRef?: { resource?: string }
  }
}

interface EnvFromSource {
  prefix?: string
  configMapRef?: { name?: string; optional?: boolean }
  secretRef?: { name?: string; optional?: boolean }
}

interface Container {
  name?: string
  env?: EnvVar[]
  envFrom?: EnvFromSource[]
}

interface PodSpec {
  containers?: Container[]
  initContainers?: Container[]
  ephemeralContainers?: Container[]
}

function allContainers(object: K8sObject): Array<{ container: Container; type: ContainerType }> {
  const spec = (object.spec as PodSpec | undefined) ?? {}
  return [
    ...(spec.initContainers ?? []).map((c) => ({ container: c, type: "init" as const })),
    ...(spec.containers ?? []).map((c) => ({ container: c, type: "container" as const })),
    ...(spec.ephemeralContainers ?? []).map((c) => ({ container: c, type: "ephemeral" as const })),
  ]
}

/** Unique ConfigMap/Secret names referenced by any container's env/envFrom. */
export function collectEnvSourceNames(object: K8sObject): {
  configMaps: string[]
  secrets: string[]
} {
  const cms = new Set<string>()
  const secrets = new Set<string>()
  for (const { container } of allContainers(object)) {
    for (const e of container.env ?? []) {
      const cm = e.valueFrom?.configMapKeyRef?.name
      if (cm !== undefined && cm !== "") cms.add(cm)
      const s = e.valueFrom?.secretKeyRef?.name
      if (s !== undefined && s !== "") secrets.add(s)
    }
    for (const ef of container.envFrom ?? []) {
      const cm = ef.configMapRef?.name
      if (cm !== undefined && cm !== "") cms.add(cm)
      const s = ef.secretRef?.name
      if (s !== undefined && s !== "") secrets.add(s)
    }
  }
  return { configMaps: [...cms], secrets: [...secrets] }
}

function resolveKeyRef(
  map: Map<string, Record<string, string> | null>,
  ref: KeyRef,
  okKind: "configmap" | "secret",
  refKind: "ConfigMap" | "Secret",
): { kind: EnvValueKind; value: string; source: EnvSource } {
  const objName = ref.name ?? ""
  const key = ref.key ?? ""
  const source: EnvSource =
    objName !== ""
      ? { ref: { kind: refKind, name: objName }, key: key !== "" ? key : undefined }
      : { label: refKind }
  if (objName === "" || key === "") return { kind: "missing", value: "", source }
  const data = map.get(objName)
  if (data === undefined || data === null) {
    return { kind: "missing", value: `(cannot read ${refKind.toLowerCase()})`, source }
  }
  // Own keys only: ConfigMap/Secret key names may legitimately be "toString",
  // "constructor" or "valueOf", and a prototype-chain hit would resolve the
  // Object.prototype member instead of reporting the key as absent.
  if (!Object.hasOwn(data, key)) return { kind: "missing", value: "(key not found)", source }
  return { kind: okKind, value: data[key] ?? "", source }
}

function resolveEnvVar(e: EnvVar, resolver: EnvResolver): { kind: EnvValueKind; value: string; source: EnvSource } {
  if (e.value !== undefined) return { kind: "literal", value: e.value, source: { label: "inline" } }
  const vf = e.valueFrom
  // Bare `- name: FOO` (no value, no valueFrom) is an inline empty value, not
  // an unknown source.
  if (vf === undefined) return { kind: "literal", value: "", source: { label: "inline" } }
  if (vf.configMapKeyRef !== undefined) {
    return resolveKeyRef(resolver.configMaps, vf.configMapKeyRef, "configmap", "ConfigMap")
  }
  if (vf.secretKeyRef !== undefined) {
    return resolveKeyRef(resolver.secrets, vf.secretKeyRef, "secret", "Secret")
  }
  if (vf.fieldRef?.fieldPath !== undefined) {
    return { kind: "field", value: vf.fieldRef.fieldPath, source: { label: "fieldRef" } }
  }
  if (vf.resourceFieldRef?.resource !== undefined) {
    return { kind: "field", value: vf.resourceFieldRef.resource, source: { label: "resourceFieldRef" } }
  }
  return { kind: "missing", value: "", source: { label: "unknown" } }
}

function expandEnvFrom(
  merged: Map<string, EnvRow>,
  map: Map<string, Record<string, string> | null>,
  objName: string,
  prefix: string,
  kind: "configmap" | "secret",
  refKind: "ConfigMap" | "Secret",
  container: string,
  containerType: ContainerType,
): void {
  const source: EnvSource = { ref: { kind: refKind, name: objName } }
  const data = map.get(objName)
  if (data === undefined || data === null) {
    // Keys can't be enumerated without reading the object; surface one row.
    const name = `${prefix}*`
    merged.set(name, {
      container,
      containerType,
      name,
      kind: "missing",
      value: `(cannot read ${refKind.toLowerCase()})`,
      source,
    })
    return
  }
  for (const key of Object.keys(data)) {
    const name = `${prefix}${key}`
    merged.set(name, { container, containerType, name, kind, value: data[key] ?? "", source })
  }
}

/** Effective, globally name-sorted env rows across all of the Pod's containers. */
export function buildEnvRows(object: K8sObject, resolver: EnvResolver): EnvRow[] {
  const rows: EnvRow[] = []
  for (const { container, type } of allContainers(object)) {
    const cname = container.name ?? ""
    // Effective env the container sees: envFrom first, then env overrides.
    const merged = new Map<string, EnvRow>()
    for (const ef of container.envFrom ?? []) {
      const prefix = ef.prefix ?? ""
      if (ef.configMapRef?.name !== undefined && ef.configMapRef.name !== "") {
        expandEnvFrom(merged, resolver.configMaps, ef.configMapRef.name, prefix, "configmap", "ConfigMap", cname, type)
      }
      if (ef.secretRef?.name !== undefined && ef.secretRef.name !== "") {
        expandEnvFrom(merged, resolver.secrets, ef.secretRef.name, prefix, "secret", "Secret", cname, type)
      }
    }
    for (const e of container.env ?? []) {
      if (e.name === undefined || e.name === "") continue
      const resolved = resolveEnvVar(e, resolver)
      merged.set(e.name, { container: cname, containerType: type, name: e.name, ...resolved })
    }
    rows.push(...merged.values())
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.container.localeCompare(b.container))
  return rows
}
