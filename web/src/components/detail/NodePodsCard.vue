<script setup lang="ts">
// Pods scheduled on a Node, as a compact table. Uses the Kubernetes Table API
// (server-computed Ready/Status/Restarts/Age/IP columns — identical to the
// list page and kubectl) narrowed by the spec.nodeName field selector, walking
// continue tokens so nodes with a high --max-pods aren't silently truncated.
// The Node column is intentionally dropped (it's this node). The pods query is
// cluster-wide, so it needs cluster-level list-pods RBAC; namespace-scoped
// users get a forbidden error surfaced in the card.

import { computed, onMounted, ref, watch } from "vue"

import { messageFromError } from "@/api/http"
import { listAllAsTable } from "@/api/k8s"
import type { K8sObject, ResourceRef } from "@/api/types"
import ResourceMiniTable from "@/components/detail/ResourceMiniTable.vue"
import { tableToMini, type MiniRow } from "@/utils/miniTable"

const props = defineProps<{ object: K8sObject }>()

const PODS_REF: ResourceRef = { group: "", version: "v1", resource: "pods" }
// Server columns worth showing (kubectl order); Name comes from the row link,
// Node/Nominated Node/Readiness Gates are dropped as noise here.
const SHOWN_COLUMNS = ["Ready", "Status", "Restarts", "Age", "IP"]

const columns = ref<string[]>([])
const rows = ref<MiniRow[]>([])
const truncated = ref(false)
const loading = ref(false)
const errorText = ref<string | null>(null)

// Guards against a stale in-flight response overwriting a newer node's pods.
let loadId = 0

async function load(): Promise<void> {
  const id = ++loadId
  const nodeName = props.object.metadata?.name
  rows.value = []
  errorText.value = null
  truncated.value = false
  if (nodeName === undefined || nodeName === "") return
  loading.value = true
  try {
    // maxPages 3 × 500 covers even high --max-pods nodes (EKS up to ~737).
    const result = await listAllAsTable(PODS_REF, {
      fieldSelector: `spec.nodeName=${nodeName}`,
      limit: 500,
      maxPages: 3,
    })
    if (id !== loadId) return
    const mini = tableToMini(result.table, { keepOnly: SHOWN_COLUMNS })
    mini.rows.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
    columns.value = mini.columns
    rows.value = mini.rows
    truncated.value = result.truncated
  } catch (e) {
    if (id !== loadId) return
    errorText.value = messageFromError(e)
  } finally {
    if (id === loadId) loading.value = false
  }
}

onMounted(load)
// Object identity, not uid: an explicit refresh of the same node (Refresh
// button, cordon/uncordon) hands over a new object and must re-scan its pods.
watch(() => props.object, load)

const hasContent = computed(
  () => loading.value || errorText.value !== null || rows.value.length > 0,
)
</script>

<template>
  <section
    v-if="hasContent"
    class="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
  >
    <h3 class="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
      Pods<span v-if="rows.length > 0" class="ml-1 font-normal normal-case">
        ({{ rows.length }}{{ truncated ? "+" : "" }})</span>
    </h3>
    <p v-if="loading" class="text-sm text-slate-400">Loading...</p>
    <p v-else-if="errorText !== null" class="text-sm text-slate-400">
      Cannot load pods: {{ errorText }}
    </p>
    <ResourceMiniTable
      v-else
      :link-ref="PODS_REF"
      :columns="columns"
      :rows="rows"
      show-namespace
    />
  </section>
</template>
