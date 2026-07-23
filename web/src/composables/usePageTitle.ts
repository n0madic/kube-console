// Keeps document.title naming the cluster this tab is on, so a row of open
// tabs is tellable apart. The label follows the active context, or the
// operator's --cluster-name where one is configured.

import { watchEffect } from "vue"

import { useContextsQuery } from "@/composables/useContexts"
import { useAuthStore } from "@/stores/auth"
import { pageTitle } from "@/utils/pageTitle"

/**
 * Mount once, from the root component: the title is per tab, not per route.
 * Reads the contexts query only for its clusterName — the query is shared by
 * key with the cluster switcher, so this adds no request.
 */
export function usePageTitle(): void {
  const auth = useAuthStore()
  const query = useContextsQuery()
  watchEffect(() => {
    document.title = pageTitle(query.data.value?.clusterName, auth.activeContext)
  })
}
