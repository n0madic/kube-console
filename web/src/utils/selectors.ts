// Convert a Kubernetes LabelSelector into the string form accepted by the
// labelSelector query parameter.

export interface LabelSelector {
  matchLabels?: Record<string, string>
  matchExpressions?: Array<{ key: string; operator: string; values?: string[] }>
}

export function selectorToString(selector: LabelSelector | undefined): string {
  if (selector === undefined) return ""
  const parts: string[] = []
  for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
    parts.push(`${key}=${value}`)
  }
  for (const expr of selector.matchExpressions ?? []) {
    switch (expr.operator) {
      case "In":
        parts.push(`${expr.key} in (${(expr.values ?? []).join(",")})`)
        break
      case "NotIn":
        parts.push(`${expr.key} notin (${(expr.values ?? []).join(",")})`)
        break
      case "Exists":
        parts.push(expr.key)
        break
      case "DoesNotExist":
        parts.push(`!${expr.key}`)
        break
    }
  }
  return parts.join(",")
}
