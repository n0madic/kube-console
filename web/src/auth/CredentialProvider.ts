// CredentialProvider abstracts how the SPA obtains a Kubernetes bearer token.
// The resource layer only ever sees this interface, so swapping the manual
// token flow for OIDC later requires no changes outside src/auth/.

export interface CredentialProvider {
  /** Returns the current bearer token, or null when not authenticated. */
  getBearerToken(): Promise<string | null>
  /** Returns the active kubeconfig context name, or null for the default. */
  getContext(): string | null
  /** Drops the session credentials of one context — the one the caller was
   * talking to, which may no longer be the active one. Defaults to the active
   * context when omitted. */
  logout(context?: string): Promise<void>
}

// Future OIDC direction (not implemented — see README roadmap):
//
//   export class OIDCPKCEProvider implements CredentialProvider {
//     // SPA Authorization Code + PKCE flow; the resulting ID/access token is
//     // accepted by the kube-apiserver and used in the same
//     // `Authorization: Bearer` flow. No impersonation.
//   }
