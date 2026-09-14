<script setup lang="ts">
// Navigation between dependent resources. Object-backed groups render as
// compact tables built from the Kubernetes Table API (server-computed
// columns, universal — no per-kind field hardcoding). The pod-owner groups
// (Deployment→ReplicaSets+Pods, ReplicaSet/StatefulSet/DaemonSet/Job→Pods,
// Service→Pods via its label selector) come **injected** from the detail
// page's one resolution (useOwnedPods, shared with the workload Logs tab —
// the walk that used to run here on every mount of the Overview), narrowed
// server-side by labels and filtered by ownerReferences.uid. What this card
// still loads itself is CronJob→Jobs (a bounded full walk: jobs carry no
// selector guarantee) and Ingress→Backend Services as a link list (names
// come from the ingress spec, the objects aren't fetched). Parents are linked
// from the Owners row in the metadata card; Node→Pods lives in NodePodsCard.

import { computed, inject, onMounted, ref, watch } from "vue"
import type { RouteLocationRaw } from "vue-router"

import { messageFromError } from "@/api/http"
import { listAllAsTable } from "@/api/k8s"
import type { K8sObject, ResourceRef } from "@/api/types"
import ResourceMiniTable from "@/components/detail/ResourceMiniTable.vue"
import { OWNED_PODS_KEY } from "@/composables/useOwnedPods"
import { resourceDetailRoute, resourceListRoute } from "@/router"
import { tableToMini, type MiniRow } from "@/utils/miniTable"
import { PODS_REF, REPLICASETS_REF, ownedBy } from "@/utils/ownedPods"

const props = defineProps<{ object: K8sObject }>()

// No provider (a card mounted outside the detail page) reads as "no owner
// groups" — one code path, no fallback resolution of its own.
const owned = inject(OWNED_PODS_KEY, null)

const JOBS_REF: ResourceRef = { group: "batch", version: "v1", resource: "jobs" }

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
  moreLink: RouteLocationRaw | null
}

type RelatedGroup = LinksGroup | TableGroup

const ownGroups = ref<RelatedGroup[]>([])
const ownLoading = ref(false)
const ownError = ref<string | null>(null)

// Guards against a stale in-flight response overwriting a newer object's data.
let loadId = 0

const MAX_ROWS = 50
const MAX_LINKS = 15

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
    // No Namespace column: children share the parent's namespace, so
    // ResourceMiniTable's show-namespace is deliberately left unbound.
    moreLink: mini.rows.length > MAX_ROWS || truncated ? resourceListRoute(linkRef) : null,
  }
}

// CronJob → Jobs, the one owner relation the card still walks itself: jobs
// carry no selector guarantee, so this is a bounded full walk of the
// namespace filtered by ownerReferences.uid. Pod owners live in
// utils/ownedPods.ts and arrive injected (below).
async function loadCronJobJobs(): Promise<RelatedGroup | null> {
  const meta = props.object.metadata
  if (meta?.uid === undefined) return null
  const { table, truncated } = await listAllAsTable(JOBS_REF, {
    namespace: meta.namespace,
    maxPages: 6, // up to 3000 objects scanned
  })
  const mini = tableToMini(table, { rowFilter: ownedBy(meta.uid) })
  if (mini.rows.length === 0) return null
  return tableGroup("Jobs", JOBS_REF, mini, truncated)
}

// The injected pod-owner groups, in the order the walk produced them:
// ReplicaSets (a Deployment's first hop) ahead of the Pods they own.
const ownedGroups = computed<RelatedGroup[]>(() => {
  const result = owned?.value.result ?? null
  if (result === null) return []
  const groups: RelatedGroup[] = []
  if (result.replicaSets !== undefined) {
    const mini = tableToMini(result.replicaSets.table)
    if (mini.rows.length > 0) {
      groups.push(tableGroup("ReplicaSets", REPLICASETS_REF, mini, result.replicaSets.truncated))
    }
  }
  const pods = tableToMini(result.pods)
  if (pods.rows.length > 0) {
    groups.push(tableGroup("Pods", PODS_REF, pods, result.truncated, result.selector))
  }
  return groups
})

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
  ownGroups.value = []
  ownError.value = null
  const collected: RelatedGroup[] = []
  ownLoading.value = true
  try {
    if (`${props.object.apiVersion ?? ""}/${props.object.kind ?? ""}` === "batch/v1/CronJob") {
      const jobs = await loadCronJobJobs()
      if (jobs !== null) collected.push(jobs)
    }
    if (props.object.kind === "Ingress") {
      const services = ingressServices()
      if (services !== null) collected.push(services)
    }
    if (id !== loadId) return
    ownGroups.value = collected
  } catch (e) {
    if (id !== loadId) return
    ownError.value = messageFromError(e)
  } finally {
    if (id === loadId) ownLoading.value = false
  }
}

onMounted(load)
// Keyed on the object's identity, not its uid: the detail page replaces the
// object on every explicit refresh (Refresh button, YAML apply, kind-specific
// action), and the children have to be re-scanned then too — a manual CronJob
// run changes exactly this table while the uid stays the same. (The injected
// groups are re-resolved by the page on the same trigger.)
watch(() => props.object, load)

// Own and injected state merged into one card: while either loads the card
// says so rather than showing the previous object's tables.
const groups = computed(() => [...ownedGroups.value, ...ownGroups.value])
const loading = computed(() => ownLoading.value || (owned?.value.loading ?? false))
const errorText = computed(() => ownError.value ?? owned?.value.error ?? null)

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
