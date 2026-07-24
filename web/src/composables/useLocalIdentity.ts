// Identity for the local kubeconfig mode: who the backend's own credentials
// authenticate as, from the same SelfSubjectReview the login flow uses.
//
// It is a query rather than a one-shot fetch so a cluster switch re-asks — the
// kubeconfig may authenticate as a different user per context — and the result
// is written into the auth store instead of being returned. TopBar then keeps
// reading `auth.identity` exactly as it does with a pasted token, and stays free
// of vue-query.

import { useQuery } from "@tanstack/vue-query"
import { computed, watch } from "vue"

import { fetchIdentity } from "@/api/ui"
import { useAuthStore } from "@/stores/auth"

export function useLocalIdentity() {
  const auth = useAuthStore()
  const query = useQuery({
    // Context-scoped like every other query key, so evictContextCaches prunes it.
    queryKey: computed(() => ["identity", auth.activeContext]),
    queryFn: fetchIdentity,
    enabled: computed(() => auth.localAuth),
    staleTime: 5 * 60 * 1000,
  })

  watch(
    () => query.data.value,
    (data) => {
      if (data === undefined) {
        // A context switch empties the data for the new key. Clear rather than
        // return: the kubeconfig may authenticate as a different user per
        // context, so keeping the previous one would leave TopBar naming the
        // wrong identity while requests already go to the new cluster.
        auth.setLocalIdentity(null, false)
        return
      }
      auth.setLocalIdentity(data.identity ?? null, data.identityUnavailable === true)
    },
    { immediate: true },
  )

  return query
}
