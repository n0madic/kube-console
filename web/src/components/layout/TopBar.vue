<script setup lang="ts">
import { useRouter } from "vue-router"

import BaseButton from "@/components/ui/BaseButton.vue"
import { useAuthStore } from "@/stores/auth"
import { useUiStore } from "@/stores/ui"

import NamespaceSelector from "./NamespaceSelector.vue"
import SidebarToggle from "./SidebarToggle.vue"
import ThemeToggle from "./ThemeToggle.vue"

const auth = useAuthStore()
const ui = useUiStore()
const router = useRouter()

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
  <header
    class="flex h-14 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 dark:border-slate-700 dark:bg-slate-900"
  >
    <!-- Only while the sidebar is hidden; once it is open the toggle belongs to
         its own header, next to the product name. -->
    <SidebarToggle v-if="!ui.sidebarOpen" class="-ml-1" />
    <NamespaceSelector />
    <div class="ml-auto flex items-center gap-3">
      <ThemeToggle />
      <span class="text-sm text-slate-500 dark:text-slate-400">
        <template v-if="auth.identity !== null">{{ auth.identity.username }}</template>
        <template v-else-if="auth.identityUnavailable">signed in (identity unavailable)</template>
      </span>
      <!-- Nothing to sign out of in the local kubeconfig mode: the credentials
           are the backend's, and the login page it leads to has no form to
           come back through. -->
      <BaseButton
        v-if="!auth.localAuth"
        variant="ghost"
        :title="auth.activeContext !== '' ? `Sign out of ${auth.activeContext}` : 'Sign out'"
        @click="logout"
      >
        Sign out
      </BaseButton>
    </div>
  </header>
</template>
