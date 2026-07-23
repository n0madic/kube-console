// Clients for the /api/ui/* adapter endpoints.

import { apiFetch, apiJson } from "./http"
import type {
  ContextsResponse,
  DiscoveryResponse,
  MetricsCapabilities,
  MetricsResponse,
  VerifyResponse,
} from "./types"

/**
 * Verify a candidate token, optionally against a specific context. Sends the
 * token (and context) explicitly — the session store is not populated yet — and
 * never routes a 401 through the global logout. The response's resolved context
 * is what the caller stores the session under.
 */
export async function verifyToken(token: string, context?: string): Promise<VerifyResponse> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (context !== undefined && context !== "") headers["X-Kube-Context"] = context
  const resp = await apiFetch("/api/ui/auth/verify", {
    method: "POST",
    headers,
    skipUnauthorizedHandler: true,
  })
  return (await resp.json()) as VerifyResponse
}

/** List the kubeconfig contexts (names + default). Requires an active session. */
export function fetchContexts(): Promise<ContextsResponse> {
  return apiJson<ContextsResponse>("/api/ui/contexts")
}

export function fetchDiscovery(): Promise<DiscoveryResponse> {
  return apiJson<DiscoveryResponse>("/api/ui/discovery")
}

export function fetchMetricsCapabilities(): Promise<MetricsCapabilities> {
  return apiJson<MetricsCapabilities>("/api/ui/metrics/capabilities")
}

export function fetchPodMetrics(namespace: string, name: string): Promise<MetricsResponse> {
  return apiJson<MetricsResponse>(
    `/api/ui/metrics/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
  )
}

export function fetchNamespacePodMetrics(namespace: string): Promise<MetricsResponse> {
  const query = namespace === "" ? "" : `?namespace=${encodeURIComponent(namespace)}`
  return apiJson<MetricsResponse>(`/api/ui/metrics/pods${query}`)
}

export function fetchNodeMetrics(name: string): Promise<MetricsResponse> {
  return apiJson<MetricsResponse>(`/api/ui/metrics/nodes/${encodeURIComponent(name)}`)
}

export function fetchAllNodeMetrics(): Promise<MetricsResponse> {
  return apiJson<MetricsResponse>("/api/ui/metrics/nodes")
}
