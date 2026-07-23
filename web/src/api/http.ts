// apiFetch: the single fetch wrapper for all backend calls. It injects the
// bearer token from the CredentialProvider, converts error bodies into
// ApiError (with the Kubernetes Status when present) and triggers logout on
// 401. The token never touches URLs, storage or logs.

import type { CredentialProvider } from "@/auth/CredentialProvider"
import type { K8sStatus } from "./types"

/**
 * Error handlers are told which cluster context the failed request was routed
 * to ("" when it carried none). A response can land long after the user has
 * switched clusters, so nothing global may be derived from "the active context"
 * at that point — see apiFetch.
 */
type ContextHandler = (context: string) => void

let provider: CredentialProvider | null = null
let onUnauthorized: ContextHandler | null = null
let onUnknownContext: ContextHandler | null = null

export function setCredentialProvider(p: CredentialProvider | null): void {
  provider = p
}

/** Used by non-fetch transports (exec WebSocket) to obtain the token. */
export function getCredentialProvider(): CredentialProvider | null {
  return provider
}

/** Registered by the app entry point: clears that context's session and, when
 * it is still the active one, shows login. */
export function setUnauthorizedHandler(handler: ContextHandler | null): void {
  onUnauthorized = handler
}

/**
 * Registered by the app entry point: the backend rejected the X-Kube-Context
 * header (context removed from the kubeconfig). Reset to the default context
 * and refresh the context list.
 */
export function setUnknownContextHandler(handler: ContextHandler | null): void {
  onUnknownContext = handler
}

/** The backend's 400 message for an unrecognized X-Kube-Context value. */
const UNKNOWN_CONTEXT_MESSAGE = "unknown cluster context"

export class ApiError extends Error {
  readonly status: number
  readonly k8sStatus: K8sStatus | null

  constructor(status: number, message: string, k8sStatus: K8sStatus | null = null) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.k8sStatus = k8sStatus
  }
}

/**
 * Human-readable message for any thrown value. ApiError carries a curated
 * message (Kubernetes Status when present); anything else falls back to the
 * given text or String(e).
 */
export function messageFromError(e: unknown, fallback?: string): string {
  if (e instanceof ApiError) return e.message
  return fallback ?? String(e)
}

/** Normalize any thrown value into an ApiError (status 0 for non-HTTP). */
export function asApiError(e: unknown): ApiError {
  return e instanceof ApiError ? e : new ApiError(0, String(e))
}

async function toApiError(resp: Response): Promise<ApiError> {
  let k8sStatus: K8sStatus | null = null
  let message = `${resp.status} ${resp.statusText}`.trim()
  try {
    const body: unknown = await resp.json()
    if (typeof body === "object" && body !== null && (body as K8sStatus).kind === "Status") {
      k8sStatus = body as K8sStatus
      if (k8sStatus.message) message = k8sStatus.message
    }
  } catch {
    // non-JSON error body; keep the generic message
  }
  return new ApiError(resp.status, message, k8sStatus)
}

export interface ApiFetchOptions extends RequestInit {
  /** Skip the global session-mutating handlers — 401 → logout and 400 →
   * unknown-context reset (used by the login flow itself). */
  skipUnauthorizedHandler?: boolean
}

/**
 * Perform an authenticated same-origin request. Throws ApiError for non-2xx
 * responses; the caller owns the successful Response (body/stream).
 */
export async function apiFetch(path: string, init: ApiFetchOptions = {}): Promise<Response> {
  const { skipUnauthorizedHandler, ...rest } = init
  const headers = new Headers(rest.headers)
  // A caller-supplied Authorization header (e.g. verifyToken checking a
  // candidate token) takes precedence over the session token, so verification
  // always tests exactly the token that was passed in.
  if (!headers.has("Authorization")) {
    const token = provider ? await provider.getBearerToken() : null
    if (token !== null && token !== "") {
      headers.set("Authorization", `Bearer ${token}`)
    }
  }
  // Route the request to the active cluster. A caller-supplied header (e.g.
  // verifyToken verifying a specific context) wins; the value is only ever a
  // registry key and is stripped before reaching the apiserver.
  if (!headers.has("X-Kube-Context")) {
    const context = provider ? provider.getContext() : null
    if (context !== null && context !== "") {
      headers.set("X-Kube-Context", context)
    }
  }
  // The cluster this request is addressed to, captured BEFORE the await: the
  // user may switch clusters while it is in flight, and a late failure must
  // only ever end the session of the cluster it was actually sent to. "" means
  // the request carried no context header (the backend's default).
  const requestContext = headers.get("X-Kube-Context") ?? ""

  const resp = await fetch(path, { ...rest, headers })
  if (resp.ok) return resp

  const error = await toApiError(resp)
  if (resp.status === 401 && !skipUnauthorizedHandler) {
    await provider?.logout(requestContext)
    onUnauthorized?.(requestContext)
  } else if (
    resp.status === 400 &&
    !skipUnauthorizedHandler &&
    error.message === UNKNOWN_CONTEXT_MESSAGE
  ) {
    // The selected context no longer exists upstream; fall back to the default.
    // The login flow opts out (skipUnauthorizedHandler) of session-mutating
    // global handlers, so a verify against a removed context only surfaces the
    // error instead of resetting the active context mid-login.
    onUnknownContext?.(requestContext)
  }
  throw error
}

/** apiFetch + JSON body decode. */
export async function apiJson<T>(path: string, init: ApiFetchOptions = {}): Promise<T> {
  const resp = await apiFetch(path, init)
  return (await resp.json()) as T
}
