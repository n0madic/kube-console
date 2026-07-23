<script setup lang="ts">
import { computed } from "vue"

import type { MetricsUIState } from "@/composables/useMetricsPolling"

const props = defineProps<{ state: MetricsUIState }>()

const messages: Record<MetricsUIState, string> = {
  loading: "Checking Metrics Server availability...",
  available: "",
  "not-installed":
    "Metrics Server is not installed in this cluster, so live CPU/memory charts are not available.",
  forbidden:
    "Your account is not allowed to read metrics.k8s.io. Ask a cluster administrator for read access to pod and node metrics.",
  unavailable:
    "Metrics Server is currently unreachable. Charts will work again once metrics.k8s.io responds.",
  disabled: "The metrics adapter is disabled in the kube-console backend configuration.",
  "user-disabled": "Metrics polling is turned off in your preferences.",
}

const message = computed(() => messages[props.state])
</script>

<template>
  <div
    class="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400"
    :data-state="state"
  >
    {{ message }}
  </div>
</template>
