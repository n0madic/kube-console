<script setup lang="ts">
import { computed } from "vue"
import { useRouter } from "vue-router"

import BaseButton from "@/components/ui/BaseButton.vue"
import { useAuthStore } from "@/stores/auth"
import { useUiStore } from "@/stores/ui"

import ClusterName from "./ClusterName.vue"
import NamespaceSelector from "./NamespaceSelector.vue"
import SidebarToggle from "./SidebarToggle.vue"
import ThemeToggle from "./ThemeToggle.vue"

const auth = useAuthStore()
const ui = useUiStore()
const router = useRouter()

// One string, because it is both the text and the tooltip: a service account
// reads `system:serviceaccount:<ns>:<name>` and has to truncate, which must not
// be the only copy of it on the page.
const identityLabel = computed(() => {
  if (auth.identity !== null) return auth.identity.username
  return auth.identityUnavailable ? "signed in (identity unavailable)" : ""
})

// Signs out of the current cluster only: other contexts keep their tokens and
// caches, and the active context name is kept so the login page names the
// cluster being signed back into (leaving it is not a context switch).
// clearActiveSession evicts this context's chart buffers and query cache too.
async function logout(): Promise<void> {
  auth.clearActiveSession()
  await router.push({ name: "login" })
}
</script>

<template>
  <!-- Everything here has to survive a phone-width header, where the row's
       min-content width is what makes labels collide. So: tighter gaps, every
       group shrinkable (`min-w-0`), captions dropped and long values truncated
       — with the full text kept in a `title`. Plain CSS breakpoints, not
       `ui.narrowViewport`: this is pure layout at several widths, while the
       store flag is for the behavioural switches (drawer, theme cycling). -->
  <header
    class="flex h-14 items-center gap-2 border-b border-slate-200 bg-white px-4 sm:gap-4 dark:border-slate-700 dark:bg-slate-900"
  >
    <!-- Only while the sidebar is hidden: the toggle then belongs here rather
         than in the sidebar header, and the cluster label has to go somewhere —
         it lives in the sidebar, which on a narrow viewport hides itself, and
         "which cluster is this" must not depend on the tab title. -->
    <template v-if="!ui.sidebarOpen">
      <SidebarToggle class="-ml-1" />
      <ClusterName inline />
    </template>
    <NamespaceSelector />
    <!-- The controls never shrink; the identity between them does, so it uses
         whatever width is left instead of being sized by a breakpoint. -->
    <div class="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
      <ThemeToggle class="shrink-0" />
      <!-- Sized by the room that is actually left, not by a breakpoint: it is
           the only shrinkable item in this group, so it takes the slack and
           truncates into it (capped, so it cannot crowd out the selector).
           The one fixed rule is the phone floor — under 30rem the pressure
           would fall on the cluster name instead, and which cluster this is
           outranks who is signed into it. -->
      <span
        v-if="identityLabel !== ''"
        class="min-w-0 max-w-[16rem] truncate text-sm text-slate-500 max-[30rem]:hidden dark:text-slate-400"
        :title="identityLabel"
      >
        {{ identityLabel }}
      </span>
      <!-- Nothing to sign out of in the local kubeconfig mode: the credentials
           are the backend's, and the login page it leads to has no form to
           come back through. -->
      <BaseButton
        v-if="!auth.localAuth"
        variant="ghost"
        class="shrink-0"
        :title="auth.activeContext !== '' ? `Sign out of ${auth.activeContext}` : 'Sign out'"
        @click="logout"
      >
        Sign out
      </BaseButton>
    </div>
  </header>
</template>
