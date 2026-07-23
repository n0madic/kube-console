<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { useRouter } from "vue-router"

import type { ResourceRef } from "@/api/types"
import DeleteConfirmDialog from "@/components/detail/DeleteConfirmDialog.vue"
import EditYamlDialog from "@/components/detail/EditYamlDialog.vue"
import OverviewTab from "@/components/detail/OverviewTab.vue"
import ResourceActions from "@/components/detail/ResourceActions.vue"
import YamlTab from "@/components/detail/YamlTab.vue"
import NodeMetricsTab from "@/components/node/NodeMetricsTab.vue"
import PodEnvTab from "@/components/pod/PodEnvTab.vue"
import PodLogsTab from "@/components/pod/PodLogsTab.vue"
import PodMetricsTab from "@/components/pod/PodMetricsTab.vue"
import PodTerminalTab from "@/components/pod/PodTerminalTab.vue"
import BaseButton from "@/components/ui/BaseButton.vue"
import BaseTabs from "@/components/ui/BaseTabs.vue"
import { useResourceObject } from "@/composables/useResourceObject"
import { resourceListRoute } from "@/router"
import { CLUSTER_SCOPE_SENTINEL } from "@/utils/k8sNames"

const props = defineProps<{
  group: string
  version: string
  resource: string
  namespace: string
  name: string
}>()

const router = useRouter()

const apiRef = computed<ResourceRef>(() => ({
  group: props.group === "core" ? "" : props.group,
  version: props.version,
  resource: props.resource,
}))

const objectNamespace = computed(() =>
  props.namespace === CLUSTER_SCOPE_SENTINEL ? undefined : props.namespace,
)

const detail = useResourceObject(() => ({
  ref: apiRef.value,
  namespace: objectNamespace.value,
  name: props.name,
}))

onMounted(() => void detail.refresh())
watch(
  () => [props.group, props.version, props.resource, props.namespace, props.name],
  () => void detail.refresh(),
)

const kind = computed(() => detail.object.value?.kind ?? "")

const tabs = computed(() => {
  const base = [
    { id: "overview", label: "Overview" },
    { id: "yaml", label: "YAML" },
  ]
  if (kind.value === "Pod") {
    base.push(
      { id: "env", label: "Env" },
      { id: "logs", label: "Logs" },
      { id: "metrics", label: "Metrics" },
      { id: "terminal", label: "Terminal" },
    )
  } else if (kind.value === "Node") {
    base.push({ id: "metrics", label: "Metrics" })
  }
  return base
})

const activeTab = ref("overview")
watch(tabs, (newTabs) => {
  if (!newTabs.some((t) => t.id === activeTab.value)) activeTab.value = "overview"
})

// The terminal tab is mounted on first use and then only hidden, so its exec
// session survives switching to another tab and back. It is keyed by the object
// so navigating to another pod still remounts it (ending the old session).
const terminalMounted = ref(false)
watch(activeTab, (tab) => {
  if (tab === "terminal") terminalMounted.value = true
})

const editOpen = ref(false)
const deleteOpen = ref(false)

function onDeleted(): void {
  void router.push(resourceListRoute(apiRef.value))
}
</script>

<template>
  <div class="flex h-full flex-col p-4">
    <div class="mb-3 flex flex-wrap items-center gap-3">
      <h1 class="text-xl font-semibold">
        <RouterLink
          :to="resourceListRoute(apiRef)"
          class="text-slate-400 hover:text-blue-600 hover:underline dark:hover:text-blue-400"
          title="Back to the resource list"
        >{{ kind || resource }}</RouterLink>
        <span class="text-slate-400"> /</span> {{ name }}
      </h1>
      <span v-if="objectNamespace !== undefined" class="text-sm text-slate-400">
        in {{ objectNamespace }}
      </span>
      <div class="flex-1"></div>
      <ResourceActions
        v-if="detail.object.value !== null"
        :object="detail.object.value"
        :resource-ref="apiRef"
        @changed="detail.refresh()"
      />
      <BaseButton :disabled="detail.loading.value" @click="detail.refresh()">Refresh</BaseButton>
      <BaseButton :disabled="detail.object.value === null" @click="editOpen = true">
        Edit YAML
      </BaseButton>
      <BaseButton
        variant="danger"
        :disabled="detail.object.value === null"
        @click="deleteOpen = true"
      >
        Delete
      </BaseButton>
    </div>

    <p
      v-if="detail.error.value !== null"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
    >
      {{ detail.error.value.message }}
    </p>
    <p v-else-if="detail.loading.value && detail.object.value === null" class="text-sm text-slate-400">
      Loading...
    </p>

    <template v-if="detail.object.value !== null">
      <BaseTabs v-model="activeTab" :tabs="tabs" class="mb-4" />

      <div class="min-h-0 flex-1 overflow-auto">
        <OverviewTab v-if="activeTab === 'overview'" :object="detail.object.value" />
        <YamlTab v-else-if="activeTab === 'yaml'" :object="detail.object.value" class="h-full" />
        <PodEnvTab v-else-if="activeTab === 'env' && kind === 'Pod'" :object="detail.object.value" />
        <PodLogsTab
          v-else-if="activeTab === 'logs' && kind === 'Pod'"
          :object="detail.object.value"
          class="h-full"
        />
        <PodMetricsTab
          v-else-if="activeTab === 'metrics' && kind === 'Pod'"
          :object="detail.object.value"
        />
        <NodeMetricsTab
          v-else-if="activeTab === 'metrics' && kind === 'Node'"
          :object="detail.object.value"
        />
        <!-- Deliberately outside the v-if chain: unlike the other tabs the
             terminal owns a live exec session, so once opened it is only
             hidden, never unmounted, while the pod page stays open. Leaving
             the page (or switching pods) unmounts it and ends the session. -->
        <PodTerminalTab
          v-if="terminalMounted && kind === 'Pod'"
          v-show="activeTab === 'terminal'"
          :key="`${objectNamespace ?? ''}/${name}`"
          :object="detail.object.value"
          :active="activeTab === 'terminal'"
          class="h-full"
        />
      </div>

      <EditYamlDialog
        v-model:open="editOpen"
        :resource-ref="apiRef"
        :object="detail.object.value"
        @applied="detail.refresh()"
      />
    </template>

    <DeleteConfirmDialog
      v-model:open="deleteOpen"
      :resource-ref="apiRef"
      :namespace="objectNamespace"
      :name="name"
      @deleted="onDeleted"
    />
  </div>
</template>
