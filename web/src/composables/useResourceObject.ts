// Detail object state: fetch + manual refresh.

import { ref, shallowRef } from "vue"

import { ApiError, asApiError } from "@/api/http"
import { getObject } from "@/api/k8s"
import type { K8sObject, ResourceRef } from "@/api/types"

interface Target {
  ref: ResourceRef
  namespace: string | undefined
  name: string
}

function targetKey(t: Target): string {
  return [t.ref.group, t.ref.version, t.ref.resource, t.namespace ?? "", t.name].join("/")
}

export function useResourceObject(getTarget: () => Target | null) {
  const object = shallowRef<K8sObject | null>(null)
  const loading = ref(false)
  const error = ref<ApiError | null>(null)

  // Generation guard: when the target changes mid-fetch, a slower stale
  // response must not overwrite the newer one.
  let generation = 0
  // Which target the object currently on screen belongs to.
  let loadedKey: string | null = null

  async function refresh(): Promise<void> {
    const target = getTarget()
    if (target === null) return
    const key = targetKey(target)
    const gen = ++generation
    loading.value = true
    error.value = null
    try {
      const result = await getObject(target.ref, target.namespace, target.name)
      if (gen !== generation) return
      object.value = result
      loadedKey = key
    } catch (e) {
      if (gen !== generation) return
      error.value = asApiError(e)
      // A failed *refresh* of the object already on screen keeps it, showing
      // the error alongside: the detail view owns live children (a Pod's exec
      // session, its log stream), and clearing the object unmounts them — a
      // transient 500 would kill the user's shell. A failed load of a
      // different object still clears it, since rendering the previous
      // object's data under the new one's header would be a lie.
      if (loadedKey !== key) {
        object.value = null
        loadedKey = null
      }
    } finally {
      if (gen === generation) loading.value = false
    }
  }

  return { object, loading, error, refresh }
}
