// Kind-specific day-2 actions offered on the detail page header (scale,
// rollout restart, manual CronJob run, suspend/resume, cordon/uncordon).
// Everything here is pure: the registry decides which actions a given object
// exposes, and the builders produce the exact patch bodies kubectl would send.
// The dialog performs the request.

import type { K8sObject } from "@/api/types"

export type ResourceActionId =
  | "scale"
  | "restart"
  | "trigger"
  | "suspend"
  | "resume"
  | "cordon"
  | "uncordon"

export interface ResourceAction {
  id: ResourceActionId
  label: string
  /** Confirmation sentence rendered in the dialog. */
  confirm: string
  variant?: "primary" | "secondary" | "danger"
}

// kind key: "<apiVersion>/<Kind>" (same convention as CHILDREN_BY_OWNER in
// RelatedResourcesCard). "suspend"/"cordon" are the toggle entries: which half
// is offered depends on the object's current spec.
const ACTIONS_BY_KIND: Record<string, ResourceActionId[]> = {
  "apps/v1/Deployment": ["scale", "restart"],
  "apps/v1/StatefulSet": ["scale", "restart"],
  "apps/v1/DaemonSet": ["restart"],
  "apps/v1/ReplicaSet": ["scale"],
  "v1/ReplicationController": ["scale"],
  "batch/v1/CronJob": ["trigger", "suspend"],
  "batch/v1/Job": ["suspend"],
  "v1/Node": ["cordon"],
}

const LABELS: Record<ResourceActionId, string> = {
  scale: "Scale",
  restart: "Restart",
  trigger: "Trigger now",
  suspend: "Suspend",
  resume: "Resume",
  cordon: "Cordon",
  uncordon: "Uncordon",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function spec(object: K8sObject): Record<string, unknown> {
  return isRecord(object.spec) ? object.spec : {}
}

function kindKey(object: K8sObject): string {
  return `${object.apiVersion ?? ""}/${object.kind ?? ""}`
}

// What the action does, without naming the object: the dialog shows the target
// kind/name/namespace on its own highlighted line above this sentence, so the
// user cannot miss what is about to change.
function confirmText(id: ResourceActionId, object: K8sObject): string {
  const isJob = object.kind === "Job"
  switch (id) {
    case "scale":
      return "Set the desired replica count."
    case "restart":
      return "The controller replaces its pods one by one, honoring the update strategy."
    case "trigger":
      return "Creates a Job now, outside the schedule."
    case "suspend":
      return isJob
        ? "Its active pods are deleted; completed ones stay."
        : "No new Jobs are scheduled until it is resumed."
    case "resume":
      return isJob
        ? "Its pods are recreated and the Job continues."
        : "Jobs are scheduled again on the normal schedule."
    case "cordon":
      return "The node stops accepting new pods; the pods running on it stay."
    case "uncordon":
      return "The node becomes schedulable again."
  }
}

function action(id: ResourceActionId, object: K8sObject): ResourceAction {
  return {
    id,
    label: LABELS[id],
    confirm: confirmText(id, object),
    variant: id === "suspend" || id === "cordon" ? "danger" : "secondary",
  }
}

/** Actions available for this object; toggles resolve from its current spec. */
export function actionsFor(object: K8sObject): ResourceAction[] {
  const ids = ACTIONS_BY_KIND[kindKey(object)]
  if (ids === undefined) return []
  const current = spec(object)
  return ids.map((id) => {
    if (id === "suspend") return action(current.suspend === true ? "resume" : "suspend", object)
    if (id === "cordon") {
      return action(current.unschedulable === true ? "uncordon" : "cordon", object)
    }
    return action(id, object)
  })
}

// Same annotation key kubectl rollout restart uses, so the two do not fight
// over separate fields.
export const RESTART_ANNOTATION = "kubectl.kubernetes.io/restartedAt"

export function restartPatch(now: Date): unknown {
  return {
    spec: {
      template: { metadata: { annotations: { [RESTART_ANNOTATION]: now.toISOString() } } },
    },
  }
}

export function replicasPatch(n: number): unknown {
  return { spec: { replicas: n } }
}

/** Desired replicas as currently declared (0 when the field is absent). */
export function currentReplicas(object: K8sObject): number {
  const value = spec(object).replicas
  return typeof value === "number" ? value : 0
}

export function suspendPatch(value: boolean): unknown {
  return { spec: { suspend: value } }
}

export function unschedulablePatch(value: boolean): unknown {
  return { spec: { unschedulable: value } }
}

const MAX_NAME_LENGTH = 63

/**
 * Name for a manually triggered Job: `<cronjob>-manual-<epochSec>`, with the
 * CronJob part truncated so the result fits the 63-char DNS label limit (and
 * never ends on the separator left by the cut).
 */
export function defaultManualJobName(cronJobName: string, now: Date): string {
  const suffix = `-manual-${Math.floor(now.getTime() / 1000)}`
  const room = Math.max(MAX_NAME_LENGTH - suffix.length, 0)
  const base = cronJobName.slice(0, room).replace(/[^a-z0-9]+$/, "")
  return `${base}${suffix}`
}

/**
 * Job manifest for a manual CronJob run — parity with
 * `kubectl create job --from=cronjob/<name>`: the jobTemplate's spec verbatim,
 * its labels, its annotations plus the `instantiate: manual` marker, and a
 * plain ownerReference (no controller/blockOwnerDeletion, exactly like kubectl)
 * so deleting the CronJob garbage-collects the Job.
 */
export function manualJobFromCronJob(cronJob: K8sObject, jobName: string): K8sObject {
  const jobTemplate = spec(cronJob).jobTemplate
  const template = isRecord(jobTemplate) ? jobTemplate : {}
  const templateMeta = isRecord(template.metadata) ? template.metadata : {}
  const templateAnnotations = isRecord(templateMeta.annotations)
    ? (templateMeta.annotations as Record<string, string>)
    : {}
  const annotations: Record<string, string> = {
    "cronjob.kubernetes.io/instantiate": "manual",
    ...templateAnnotations,
  }
  const labels = isRecord(templateMeta.labels)
    ? (templateMeta.labels as Record<string, string>)
    : undefined

  const metadata: K8sObject["metadata"] = { name: jobName, annotations }
  if (labels !== undefined) metadata.labels = labels
  const uid = cronJob.metadata?.uid
  if (uid !== undefined && uid !== "") {
    metadata.ownerReferences = [
      { apiVersion: "batch/v1", kind: "CronJob", name: cronJob.metadata?.name ?? "", uid },
    ]
  }

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata,
    spec: isRecord(template.spec) ? template.spec : {},
  }
}
