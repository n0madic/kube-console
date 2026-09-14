// The detail page's one resolution of "which pods does this object own",
// shared by the workload Logs tab (which needs it to decide whether the tab
// exists at all) and the Related resources card. It is the first
// provide/inject in the repo: the card is mounted under the Overview tab, so a
// prop would have to be threaded through OverviewTab for one consumer, and
// resolving twice would be a second cluster walk (two, for a Deployment) per
// page load.

import { shallowRef, watch, type InjectionKey, type ShallowRef } from "vue"

import { messageFromError } from "@/api/http"
import { resolveOwnedPods, type OwnedPods } from "@/api/ownedPods"
import type { K8sObject } from "@/api/types"
import { podOwnerSpec } from "@/utils/ownedPods"

export interface OwnedPodsState {
  loading: boolean
  error: string | null
  /** null: not a pod owner, nothing resolved yet, or the object went away. */
  result: OwnedPods | null
}

export const OWNED_PODS_KEY: InjectionKey<ShallowRef<OwnedPodsState>> = Symbol("ownedPods")

const IDLE: OwnedPodsState = { loading: false, error: null, result: null }

export function useOwnedPods(getObject: () => K8sObject | null) {
  // A shallowRef reassigned whole on every transition: consumers (the page's
  // tab list, the card) read it through computeds, and a mutated field would
  // be invisible to them.
  const state = shallowRef<OwnedPodsState>(IDLE)

  // Guards against a stale in-flight response overwriting a newer object's data.
  let loadId = 0
  // uid of the object the current result was resolved for.
  let lastUid: string | undefined

  async function load(): Promise<void> {
    const id = ++loadId
    const object = getObject()
    if (object === null || podOwnerSpec(object) === undefined) {
      lastUid = undefined
      state.value = IDLE
      return
    }
    // A refresh of the object already on screen keeps the previous result
    // while the new one loads and when the load fails: the Logs tab exists
    // only while a result with pods is held, and the page's tab watch bounces
    // to Overview the moment it disappears — a Refresh click must not do that.
    // Another object (or none) clears at once, for the opposite reason: its
    // predecessor's pods must never be offered under the new header.
    const uid = object.metadata?.uid
    const kept = uid !== undefined && uid === lastUid ? state.value.result : null
    lastUid = uid
    state.value = { loading: true, error: null, result: kept }
    try {
      const result = await resolveOwnedPods(object)
      if (id !== loadId) return
      state.value = { loading: false, error: null, result }
    } catch (e) {
      if (id !== loadId) return
      state.value = { loading: false, error: messageFromError(e), result: kept }
    }
  }

  // Keyed on the object's identity, not its uid: the detail page replaces the
  // object on every explicit refresh (Refresh button, YAML apply, kind-specific
  // action), and the pods have to be re-scanned then too — a scale or restart
  // changes exactly this set while the uid stays the same.
  watch(getObject, () => void load(), { immediate: true })

  return { state }
}
