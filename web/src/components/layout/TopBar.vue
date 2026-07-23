<script setup lang="ts">
import { useQueryClient } from "@tanstack/vue-query"
import { useRouter } from "vue-router"

import { endActiveSession } from "@/auth/endSession"
import BaseButton from "@/components/ui/BaseButton.vue"
import { useAuthStore } from "@/stores/auth"

import NamespaceSelector from "./NamespaceSelector.vue"
import ThemeToggle from "./ThemeToggle.vue"

const auth = useAuthStore()
const router = useRouter()
const queryClient = useQueryClient()

// Signs out of the current cluster only: other contexts keep their tokens and
// caches, and the active context name is kept so the login page names the
// cluster being signed back into (leaving it is not a context switch).
async function logout(): Promise<void> {
  endActiveSession(queryClient)
  await router.push({ name: "login" })
}
</script>

<template>
  <header
    class="flex h-14 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 dark:border-slate-700 dark:bg-slate-900"
  >
    <NamespaceSelector />
    <div class="ml-auto flex items-center gap-3">
      <ThemeToggle />
      <span class="text-sm text-slate-500 dark:text-slate-400">
        <template v-if="auth.identity !== null">{{ auth.identity.username }}</template>
        <template v-else-if="auth.identityUnavailable">signed in (identity unavailable)</template>
      </span>
      <BaseButton
        variant="ghost"
        :title="auth.activeContext !== '' ? `Sign out of ${auth.activeContext}` : 'Sign out'"
        @click="logout"
      >
        Sign out
      </BaseButton>
    </div>
  </header>
</template>
