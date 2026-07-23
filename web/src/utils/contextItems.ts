// Rows of the cluster context picker (components/ui/ContextListbox.vue).
// Both owners — the sidebar switcher and the login page — build them here, so
// the two pickers always list the same clusters in the same order even though
// they draw the names from different sources.

/** One selectable cluster context. */
export interface ContextItem {
  name: string
  /** This tab holds an unexpired token for that context. */
  signedIn: boolean
}

/**
 * Deduped, name-sorted picker rows.
 *
 * Sorted rather than kept in kubeconfig order: the login page has to union
 * several sources (query cache, tab sessions, the active context) whose orders
 * are unrelated, so only a total order over the names can make both pickers
 * agree. Empty names are dropped — the active context is "" before the first
 * login and is not selectable.
 */
export function contextItems(
  names: Iterable<string>,
  hasSession: (name: string) => boolean,
): ContextItem[] {
  return [...new Set(names)]
    .filter((name) => name !== "")
    .sort()
    .map((name) => ({ name, signedIn: hasSession(name) }))
}
