<script setup lang="ts">
import { computed, ref } from "vue"
import { useRoute, useRouter } from "vue-router"

import { ApiError } from "@/api/http"
import { verifyToken } from "@/api/ui"
import BaseButton from "@/components/ui/BaseButton.vue"
import ContextListbox from "@/components/ui/ContextListbox.vue"
import { useContexts } from "@/composables/useContexts"
import { useAuthStore } from "@/stores/auth"
import { contextItems } from "@/utils/contextItems"

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const { contexts } = useContexts()

const token = ref("")
const error = ref<string | null>(null)
const loading = ref(false)

// Which context we are signing into. Empty on the very first login (no context
// list yet) — the backend resolves the default and reports it back.
const targetContext = computed(() => (auth.activeContext !== "" ? auth.activeContext : undefined))

// Switchable contexts, so landing here by an accidental switch is not a dead
// end: the sidebar (and its cluster switcher) is not rendered on this page, and
// without a way back the only exit would be pasting a token for a cluster the
// user may not even want. `/api/ui/contexts` needs a bearer for the *active*
// context — which is exactly what is missing here — so the names come from the
// query cache when it has them (switch within a live tab) unioned with the
// contexts this tab still holds a session for (the reliable source, also after
// a reload) and the active context itself (the cluster being signed into is
// always listed). `contextItems` dedupes and sorts them, so this union and the
// sidebar switcher's kubeconfig list end up in the same order.
const items = computed(() =>
  contextItems(
    [...contexts.value.map((c) => c.name), ...auth.signedInContexts(), auth.activeContext],
    (name) => auth.hasSession(name),
  ),
)

/** Where to land once a session is active: back where the switch started.
 * Only a same-origin path is honoured — a crafted `?redirect=//host` (or
 * `/\host`) would otherwise reach history.pushState as a protocol-relative
 * URL pointing off-site. */
function redirectTarget(): string {
  const redirect = route.query.redirect
  return typeof redirect === "string" && /^\/(?![/\\])/.test(redirect) ? redirect : "/overview"
}

function pick(name: string): void {
  // A verify is in flight for the current context: it ends with setSession(),
  // which activates the context it verified and navigates. Switching now would
  // be silently undone by that late result.
  if (loading.value) return
  if (name === auth.activeContext) return
  auth.setActiveContext(name)
  // The rejection belonged to the context we just left.
  error.value = null
  // Already signed into that cluster: nothing to log in to, resume where the
  // switch started. Otherwise stay — the form is now bound to the picked one.
  if (auth.isAuthenticated) void router.push(redirectTarget())
}

async function submit(): Promise<void> {
  const candidate = token.value.trim()
  if (candidate === "") {
    error.value = "Paste a Kubernetes bearer token."
    return
  }
  loading.value = true
  error.value = null
  try {
    const result = await verifyToken(candidate, targetContext.value)
    // Store under the resolved context name so first-login (no target) lands
    // under the real default name.
    auth.setSession(
      result.context ?? targetContext.value ?? "",
      candidate,
      result.identity ?? null,
      result.identityUnavailable === true,
    )
    token.value = ""
    await router.push(redirectTarget())
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      error.value = "The token was rejected by the cluster (401). Check that it is valid and not expired."
    } else if (e instanceof ApiError) {
      error.value = `Cannot verify the token: ${e.message}`
    } else {
      error.value = "Cannot reach the backend."
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="flex h-full items-center justify-center bg-slate-100 p-4 dark:bg-slate-950">
    <form
      class="w-full max-w-md rounded-xl bg-white p-8 shadow-md dark:bg-slate-900 dark:text-slate-100"
      @submit.prevent="submit"
    >
      <h1 class="mb-2 flex items-center gap-2.5 text-2xl font-semibold">
        <img src="/favicon.svg" alt="" aria-hidden="true" class="h-8 w-8 shrink-0" />
        kube-console
      </h1>
      <!-- With more than one known context the name is a picker: signing in is
           not the only way off this page, and the options carry the same
           "signed in" mark as the sidebar switcher. -->
      <div v-if="items.length > 1" class="mb-3">
        <p class="mb-1 text-sm text-slate-600 dark:text-slate-300">Cluster context:</p>
        <!-- Inert while verifying: a switch would be undone by the in-flight
             verify activating the context it was started for. -->
        <div data-testid="login-context" :class="loading ? 'pointer-events-none opacity-60' : ''">
          <ContextListbox :items="items" :selected="auth.activeContext" @select="pick" />
        </div>
      </div>
      <p
        v-else
        class="mb-3 flex flex-wrap items-baseline gap-x-1.5 text-sm text-slate-600 dark:text-slate-300"
      >
        Cluster context:
        <span
          v-if="targetContext !== undefined"
          class="font-mono font-medium text-blue-600 dark:text-blue-400"
          data-testid="login-context"
        >
          {{ targetContext }}
        </span>
        <!-- No context is selected yet on the very first login of a tab: the
             name list is behind a bearer token, so the server resolves its
             default and reports the name back on verify. -->
        <span v-else class="italic text-slate-500 dark:text-slate-400" data-testid="login-context">
          server default
        </span>
      </p>
      <p class="mb-6 text-sm text-slate-500 dark:text-slate-400">
        Sign in with a Kubernetes bearer token. The session lives only in this
        browser tab (survives reloads, expires after 8 hours) and ends when the
        tab is closed.
      </p>

      <label class="mb-1 block text-sm font-medium" for="token">Bearer token</label>
      <input
        id="token"
        v-model="token"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder="eyJhbGciOi..."
        class="mb-4 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800"
      />

      <p v-if="error !== null" class="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
        {{ error }}
      </p>

      <BaseButton type="submit" variant="primary" :disabled="loading" class="w-full justify-center">
        {{ loading ? "Verifying..." : "Sign in" }}
      </BaseButton>
    </form>
  </main>
</template>
