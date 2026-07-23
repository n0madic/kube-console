<script setup lang="ts">
// Navigation between dependent resources. Object-backed groups (ownerReferences
// children — Deployment→ReplicaSets, ReplicaSet/StatefulSet/DaemonSet/Job→Pods,
// CronJob→Jobs; Service→Pods via its label selector) render as compact tables
// built from the Kubernetes Table API (server-computed columns, universal — no
// per-kind field hardcoding), narrowed server-side by labels and filtered by
// ownerReferences.uid client-side. A Deployment additionally lists its Pods
// (grandchildren): the pods it shows are the ones owned by any ReplicaSet the
// Deployment owns (two-hop uid match), so foreign pods matching an overlapping
// selector are excluded. Ingress→Backend Services stays a link list (names come
// from the ingress spec, the objects aren't fetched). Parents are linked from
// the Owners row in the metadata card; Node→Pods lives in NodePodsCard.

import { computed, onMounted, ref, watch } from "vue"
import type { RouteLocationRaw } from "vue-router"

import { messageFromError } from "@/api/http"
import { listAllAsTable } from "@/api/k8s"
import type { K8sObject, K8sObjectMeta, ResourceRef } from "@/api/types"
import ResourceMiniTable from "@/components/detail/ResourceMiniTable.vue"
import { resourceDetailRoute, resourceListRoute } from "@/router"
import { tableToMini, type MiniRow } from "@/utils/miniTable"
import { selectorToString, type LabelSelector } from "@/utils/selectors"

const props = defineProps<{ object: K8sObject }>()

interface ChildSpec {
  ref: ResourceRef
  label: string
  /**
   * Children of these controllers carry labels matching the parent's
   * spec.selector, so the query can be narrowed server-side. CronJob jobs
   * have no such guarantee (false → bounded full walk).
   */
  useParentSelector: boolean
}

// kind key: "<apiVersion>/<Kind>" → the resource type its children live in.
const CHILDREN_BY_OWNER: Record<string, ChildSpec> = {
  "apps/v1/Deployment": {
    ref: { group: "apps", version: "v1", resource: "replicasets" },
    label: "ReplicaSets",
    useParentSelector: true,
  },
  "apps/v1/ReplicaSet": {
    ref: { group: "", version: "v1", resource: "pods" },
    label: "Pods",
    useParentSelector: true,
  },
  "apps/v1/StatefulSet": {
    ref: { group: "", version: "v1", resource: "pods" },
    label: "Pods",
    useParentSelector: true,
  },
  "apps/v1/DaemonSet": {
    ref: { group: "", version: "v1", resource: "pods" },
    label: "Pods",
    useParentSelector: true,
  },
  "batch/v1/CronJob": {
    ref: { group: "batch", version: "v1", resource: "jobs" },
    label: "Jobs",
    useParentSelector: false,
  },
  "batch/v1/Job": {
    ref: { group: "", version: "v1", resource: "pods" },
    label: "Pods",
    useParentSelector: true,
  },
}

interface RelatedLink {
  text: string
  to: RouteLocationRaw
}

interface LinksGroup {
  kind: "links"
  label: string
  links: RelatedLink[]
  moreLink: RouteLocationRaw | null
}

interface TableGroup {
  kind: "table"
  label: string
  /**
   * Label selector the rows were matched by, shown under the group title.
   * Kept out of `label`: label keys/values are case-sensitive and the title is
   * rendered uppercase.
   */
  selector?: string
  linkRef: ResourceRef
  columns: string[]
  rows: MiniRow[]
  showNamespace: boolean
  moreLink: RouteLocationRaw | null
}

type RelatedGroup = LinksGroup | TableGroup

const groups = ref<RelatedGroup[]>([])
const loading = ref(false)
const errorText = ref<string | null>(null)

// Guards against a stale in-flight response overwriting a newer object's data.
let loadId = 0

const MAX_ROWS = 50
const MAX_LINKS = 15

function ownerKey(): string {
  return `${props.object.apiVersion ?? ""}/${props.object.kind ?? ""}`
}

function tableGroup(
  label: string,
  linkRef: ResourceRef,
  mini: { columns: string[]; rows: MiniRow[] },
  truncated: boolean,
  selector?: string,
): TableGroup {
  return {
    kind: "table",
    label: truncated ? `${label} (partial scan)` : `${label} (${mini.rows.length})`,
    selector,
    linkRef,
    columns: mini.columns,
    rows: mini.rows.slice(0, MAX_ROWS),
    // Children share the parent's namespace, so a Namespace column is redundant.
    showNamespace: false,
    moreLink: mini.rows.length > MAX_ROWS || truncated ? resourceListRoute(linkRef) : null,
  }
}

// Parent selector as a label-selector string, when the controller guarantees
// its labels on children. Empty → undefined (no server-side narrowing).
function childSelector(spec: ChildSpec): string | undefined {
  if (!spec.useParentSelector) return undefined
  const s = selectorToString(
    (props.object.spec as { selector?: LabelSelector } | undefined)?.selector,
  )
  return s !== "" ? s : undefined
}

function ownedBy(uid: string): (m: K8sObjectMeta) => boolean {
  return (m) => (m.ownerReferences ?? []).some((o) => o.uid === uid)
}

async function loadOwnedChildren(spec: ChildSpec): Promise<RelatedGroup | null> {
  const meta = props.object.metadata
  if (meta?.uid === undefined) return null
  // Narrow server-side by the parent's selector labels; the ownerReferences uid
  // filter stays the source of truth either way.
  const { table, truncated } = await listAllAsTable(spec.ref, {
    namespace: meta.namespace,
    labelSelector: childSelector(spec),
    maxPages: 6, // up to 3000 objects scanned
  })
  const mini = tableToMini(table, { rowFilter: ownedBy(meta.uid) })
  if (mini.rows.length === 0) return null
  return tableGroup(spec.label, spec.ref, mini, truncated)
}

// Deployment: its ReplicaSets, plus the Pods those ReplicaSets own. Pods are
// grandchildren, so they can't be matched to the Deployment uid directly — we
// collect the owned ReplicaSet uids and match pods against that set.
async function loadDeploymentChildren(rsSpec: ChildSpec): Promise<RelatedGroup[]> {
  const meta = props.object.metadata
  if (meta?.uid === undefined) return []
  const groups: RelatedGroup[] = []

  // The ReplicaSet and Pod walks are independent — both are narrowed server-side
  // by the Deployment's own selector, and rsUids only gates the client-side pod
  // filter afterwards — so run them concurrently instead of back-to-back. (A
  // Deployment with no owned ReplicaSets does one wasted pods walk, a rare case.)
  const podsRef: ResourceRef = { group: "", version: "v1", resource: "pods" }
  const [rs, pods] = await Promise.all([
    listAllAsTable(rsSpec.ref, {
      namespace: meta.namespace,
      labelSelector: childSelector(rsSpec),
      maxPages: 6,
    }),
    listAllAsTable(podsRef, {
      namespace: meta.namespace,
      labelSelector: childSelector(rsSpec),
      maxPages: 6,
    }),
  ])

  const ownsDeployment = ownedBy(meta.uid)
  const rsMini = tableToMini(rs.table, { rowFilter: ownsDeployment })
  if (rsMini.rows.length > 0) {
    groups.push(tableGroup(rsSpec.label, rsSpec.ref, rsMini, rs.truncated))
  }

  const rsUids = new Set(
    (rs.table.rows ?? [])
      .filter((row) => ownsDeployment(row.object?.metadata ?? {}))
      .map((row) => row.object?.metadata?.uid)
      .filter((uid): uid is string => uid !== undefined),
  )
  if (rsUids.size > 0) {
    const podsMini = tableToMini(pods.table, {
      rowFilter: (m) =>
        (m.ownerReferences ?? []).some((o) => o.uid !== undefined && rsUids.has(o.uid)),
    })
    if (podsMini.rows.length > 0) {
      groups.push(tableGroup("Pods", podsRef, podsMini, pods.truncated))
    }
  }
  return groups
}

async function loadServicePods(): Promise<RelatedGroup | null> {
  const selector = (props.object.spec as { selector?: Record<string, string> } | undefined)
    ?.selector
  if (selector === undefined || Object.keys(selector).length === 0) return null
  const labelSelector = selectorToString({ matchLabels: selector })
  const podsRef: ResourceRef = { group: "", version: "v1", resource: "pods" }
  const { table, truncated } = await listAllAsTable(podsRef, {
    namespace: props.object.metadata?.namespace,
    labelSelector,
    maxPages: 4,
  })
  const mini = tableToMini(table)
  if (mini.rows.length === 0) return null
  return tableGroup("Pods", podsRef, mini, truncated, labelSelector)
}

function ingressServices(): RelatedGroup | null {
  interface IngressBackend {
    service?: { name?: string }
  }
  interface IngressSpec {
    defaultBackend?: IngressBackend
    rules?: Array<{ http?: { paths?: Array<{ backend?: IngressBackend }> } }>
  }
  const spec = props.object.spec as IngressSpec | undefined
  if (spec === undefined) return null
  const names = new Set<string>()
  const defaultName = spec.defaultBackend?.service?.name
  if (defaultName !== undefined && defaultName !== "") names.add(defaultName)
  for (const rule of spec.rules ?? []) {
    for (const path of rule.http?.paths ?? []) {
      const name = path.backend?.service?.name
      if (name !== undefined && name !== "") names.add(name)
    }
  }
  if (names.size === 0) return null
  const servicesRef: ResourceRef = { group: "", version: "v1", resource: "services" }
  const namespace = props.object.metadata?.namespace
  return {
    kind: "links",
    label: "Backend Services",
    links: [...names].slice(0, MAX_LINKS).map((name) => ({
      text: name,
      to: resourceDetailRoute(servicesRef, namespace, name),
    })),
    // Surface an overflow affordance when more backends exist than we list.
    moreLink: names.size > MAX_LINKS ? resourceListRoute(servicesRef) : null,
  }
}

async function load(): Promise<void> {
  const id = ++loadId
  groups.value = []
  errorText.value = null
  const kind = props.object.kind ?? ""
  const collected: RelatedGroup[] = []
  loading.value = true
  try {
    const childSpec = CHILDREN_BY_OWNER[ownerKey()]
    if (childSpec !== undefined) {
      if (kind === "Deployment") {
        collected.push(...(await loadDeploymentChildren(childSpec)))
      } else {
        const owned = await loadOwnedChildren(childSpec)
        if (owned !== null) collected.push(owned)
      }
    }
    if (kind === "Service") {
      const pods = await loadServicePods()
      if (pods !== null) collected.push(pods)
    }
    if (kind === "Ingress") {
      const services = ingressServices()
      if (services !== null) collected.push(services)
    }
    if (id !== loadId) return
    groups.value = collected
  } catch (e) {
    if (id !== loadId) return
    errorText.value = messageFromError(e)
  } finally {
    if (id === loadId) loading.value = false
  }
}

onMounted(load)
// Keyed on the object's identity, not its uid: the detail page replaces the
// object on every explicit refresh (Refresh button, YAML apply, kind-specific
// action), and the children have to be re-scanned then too — a scale or restart
// changes exactly this table while the uid stays the same.
watch(() => props.object, load)

const hasContent = computed(
  () => loading.value || errorText.value !== null || groups.value.length > 0,
)
</script>

<template>
  <section
    v-if="hasContent"
    class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
  >
    <h3 class="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
      Related resources
    </h3>
    <p v-if="loading" class="text-sm text-slate-400">Loading...</p>
    <p v-else-if="errorText !== null" class="text-sm text-slate-400">
      Cannot load related resources: {{ errorText }}
    </p>
    <div v-else class="space-y-3 text-sm">
      <div v-for="group in groups" :key="group.label">
        <div class="mb-1 flex flex-wrap items-baseline gap-x-2">
          <span class="text-xs font-semibold uppercase tracking-wide text-slate-400">
            {{ group.label }}
          </span>
          <span
            v-if="group.kind === 'table' && group.selector !== undefined"
            class="text-[10px] leading-none text-slate-400"
            :title="`Label selector: ${group.selector}`"
          >
            · selector <span class="font-mono">{{ group.selector }}</span>
          </span>
        </div>
        <template v-if="group.kind === 'table'">
          <ResourceMiniTable
            :link-ref="group.linkRef"
            :columns="group.columns"
            :rows="group.rows"
            :show-namespace="group.showNamespace"
          />
          <RouterLink
            v-if="group.moreLink !== null"
            :to="group.moreLink"
            class="mt-0.5 inline-block text-xs text-slate-400 hover:underline"
          >
            more…
          </RouterLink>
        </template>
        <div v-else class="flex flex-wrap gap-x-3 gap-y-0.5">
          <RouterLink
            v-for="link in group.links"
            :key="link.text"
            :to="link.to"
            class="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            {{ link.text }}
          </RouterLink>
          <RouterLink
            v-if="group.moreLink !== null"
            :to="group.moreLink"
            class="text-xs text-slate-400 hover:underline"
          >
            more…
          </RouterLink>
        </div>
      </div>
    </div>
  </section>
</template>
