// Shared API types: Kubernetes wire shapes used by the SPA and the
// /api/ui/* adapter DTOs.

export interface K8sObjectMeta {
  name?: string
  namespace?: string
  uid?: string
  resourceVersion?: string
  creationTimestamp?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  ownerReferences?: Array<{
    apiVersion: string
    kind: string
    name: string
    uid?: string
    controller?: boolean
  }>
  managedFields?: unknown
}

export interface K8sObject {
  apiVersion?: string
  kind?: string
  metadata?: K8sObjectMeta
  spec?: unknown
  status?: unknown
  data?: Record<string, string>
  type?: string
  [key: string]: unknown
}

export interface K8sObjectList {
  apiVersion?: string
  kind?: string
  metadata?: { resourceVersion?: string; continue?: string; remainingItemCount?: number }
  items: K8sObject[]
}

export interface K8sStatus {
  kind?: "Status"
  apiVersion?: string
  status?: "Success" | "Failure"
  message?: string
  reason?: string
  code?: number
  details?: {
    name?: string
    kind?: string
    causes?: Array<{ reason?: string; message?: string; field?: string }>
  }
}

// Kubernetes Table representation (meta.k8s.io/v1).
export interface K8sTableColumn {
  name: string
  type: string
  format?: string
  description?: string
  priority?: number
}

export interface K8sTableRow {
  cells: Array<string | number | boolean | null | object>
  object?: {
    kind?: string
    apiVersion?: string
    metadata?: K8sObjectMeta
  }
}

export interface K8sTable {
  kind: "Table"
  apiVersion?: string
  metadata?: { resourceVersion?: string; continue?: string; remainingItemCount?: number }
  columnDefinitions: K8sTableColumn[]
  rows?: K8sTableRow[]
}

export interface WatchEvent {
  type: "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | "ERROR"
  object: K8sObject & Partial<K8sStatus>
}

// Discovery DTO from GET /api/ui/discovery.
export interface DiscoveryResource {
  id: string
  group: string
  version: string
  resource: string
  kind: string
  namespaced: boolean
  // Nonstandard aggregated APIs may omit verbs in discovery; the backend
  // normalizes to [], but the UI must not crash on null either.
  verbs?: string[] | null
  shortNames?: string[]
  categories?: string[]
}

export interface DiscoveryResponse {
  resources: DiscoveryResource[]
}

// Auth DTO from POST /api/ui/auth/verify.
export interface Identity {
  username: string
  uid?: string
  groups?: string[]
}

export interface VerifyResponse {
  authenticated: boolean
  identity?: Identity
  identityUnavailable?: boolean
  // Resolved context the token was verified against; the frontend stores the
  // first-login session under this name.
  context?: string
}

// Contexts DTO from GET /api/ui/contexts (names + default only).
export interface ContextInfo {
  name: string
}

export interface ContextsResponse {
  contexts: ContextInfo[]
  default: string
  // Operator-set display label for the page title (--cluster-name), absent
  // unless configured. Server-global: it applies to every context.
  clusterName?: string
}

// Metrics DTOs from /api/ui/metrics/*.
export type MetricsCapabilityState =
  | "available"
  | "not-installed"
  | "forbidden"
  | "unavailable"
  | "disabled"

export interface MetricsCapabilities {
  state: MetricsCapabilityState
  group?: string
  version?: string
}

export interface ContainerUsage {
  name: string
  cpuNanoCores: number
  memoryBytes: number
}

export interface MetricsItem {
  kind: "Pod" | "Node"
  namespace?: string
  name: string
  uid?: string
  cpuNanoCores: number
  memoryBytes: number
  containers?: ContainerUsage[]
}

export interface MetricsResponse {
  observedAt: string
  windowSeconds: number
  items: MetricsItem[]
}

// Reference to a resource type, as used in routes and API paths.
export interface ResourceRef {
  group: string // "" or "core" for the core group
  version: string
  resource: string
}
