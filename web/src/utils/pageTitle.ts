// Browser page title: which cluster this tab is looking at. Pure — the
// composable does the DOM write.

export const BASE_TITLE = "kube-console"

/** Separator between the cluster label and the product name. */
const SEPARATOR = " · "

// Context names that identify no cluster: kubeadm's canned pair and the name
// kube-console synthesizes for a single --api-server / in-cluster upstream.
// Putting one of these in the tab costs the space and tells the reader nothing,
// so the title stays bare instead — an operator who wants a name in-cluster
// sets --cluster-name, which is never filtered.
const GENERIC_CONTEXTS = new Set([
  "default",
  "kubernetes",
  "kubernetes-admin",
  "kubernetes-admin@kubernetes",
  "kubernetes@kubernetes",
  "admin@kubernetes",
  "in-cluster",
])

/**
 * The cluster label for the title: the operator's --cluster-name when set —
 * for every context, that being the point of it — else the active context
 * name, or "" when that name identifies no cluster.
 */
export function clusterLabel(clusterName: string | undefined, context: string): string {
  const configured = (clusterName ?? "").trim()
  if (configured !== "") return configured
  const ctx = context.trim()
  return GENERIC_CONTEXTS.has(ctx.toLowerCase()) ? "" : ctx
}

/** Full document.title for the given cluster name / active context. */
export function pageTitle(clusterName: string | undefined, context: string): string {
  const label = clusterLabel(clusterName, context)
  return label === "" ? BASE_TITLE : label + SEPARATOR + BASE_TITLE
}
