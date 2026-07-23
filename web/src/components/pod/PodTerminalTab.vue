<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue"

import type { K8sObject } from "@/api/types"
import BaseButton from "@/components/ui/BaseButton.vue"
import EditableCombobox from "@/components/ui/EditableCombobox.vue"
import { useExecSession } from "@/composables/useExecSession"
import {
  debugContainerHint,
  defaultContainerName,
  isMissingExecutableError,
  parseCommandLine,
  podContainers,
} from "@/utils/podHelpers"
import { COMMAND_SUGGESTIONS, DEFAULT_COMMAND_LINE, isAutoCommand } from "@/utils/shellPresets"

import ContainerSelect from "./ContainerSelect.vue"
import TerminalView from "./TerminalView.vue"

// `active` is false while another tab of the pod page is shown: the component
// stays mounted (hidden) so the exec session outlives a tab switch, instead of
// being torn down and restarted from the connect form every time.
const props = withDefaults(defineProps<{ object: K8sObject; active?: boolean }>(), { active: true })

const container = ref("")

// A single-container pod has nothing to pick: a picker offering exactly one
// option reads as a choice that isn't one (and, once the session starts, as a
// disabled control for no reason). The name is still shown — it is what exec
// lands in — but as a plain pill.
const soleContainer = computed(() => {
  const all = podContainers(props.object)
  return all.length === 1 ? all[0]!.name : null
})

// One editable field: the suggestions fill it in, and it stays typeable, so a
// preset is a starting point rather than a mode. Parsed as a quoted command
// line, never run through a shell — `/bin/sh -c …` is a shell because it says
// so, not because the field is one.
const command = ref(DEFAULT_COMMAND_LINE)
const argv = computed(() => parseCommandLine(command.value))

const started = ref(false)

// Both pickers are locked for the lifetime of the session (they describe an
// exec that is already running). Dimming says *that* they are locked; this
// says why, and what to do about it.
const lockedHint = computed(() =>
  started.value ? "Disconnect first to change the container or command" : undefined,
)

const terminalRef = ref<InstanceType<typeof TerminalView> | null>(null)

const session = useExecSession({
  onOutput: (data) => terminalRef.value?.write(data),
  onExit: (code) => {
    terminalRef.value?.write(`\r\n[process exited${code !== null ? ` with code ${code}` : ""}]\r\n`)
  },
})

// A missing binary is the one exec failure the user can act on, and the action
// differs: with a hand-picked shell, try another one; with the auto command,
// not even /bin/sh is there, so no command can help.
const missingBinaryHint = computed<string | null>(() => {
  const message = session.errorMessage.value
  if (message === null || !isMissingExecutableError(message)) return null
  if (!isAutoCommand(argv.value)) {
    return "That command does not exist in this container — try the Auto command, which picks whatever shell is present."
  }
  const meta = props.object.metadata
  return debugContainerHint(meta?.namespace ?? "", meta?.name ?? "", container.value)
})

onMounted(() => {
  container.value = defaultContainerName(props.object)
})

async function start(): Promise<void> {
  const meta = props.object.metadata
  if (meta?.namespace === undefined || meta.name === undefined) return
  if (argv.value.length === 0) return
  started.value = true
  await nextTick() // mount the terminal before connecting
  terminalRef.value?.fitNow()
  await session.start({
    namespace: meta.namespace,
    pod: meta.name,
    container: container.value,
    command: argv.value,
  })
  terminalRef.value?.focus()
}

// Send the initial terminal size only once the exec stream is ready — sending
// it right after start() would race the still-CONNECTING socket and be dropped.
watch(session.status, (s) => {
  if (s !== "ready") return
  const size = terminalRef.value?.size()
  if (size !== null && size !== undefined) session.sendResize(size.cols, size.rows)
})

// Coming back to the tab: the terminal could not measure itself while hidden
// (and a window resize in the meantime was skipped), so refit before handing
// the keyboard back — otherwise the shell keeps typing into the old geometry.
watch(
  () => props.active,
  async (active) => {
    if (!active || !started.value) return
    await nextTick()
    terminalRef.value?.fitNow()
    terminalRef.value?.focus()
  },
)

function stop(): void {
  session.stop()
  started.value = false
}

// The detail page reuses this component across pod navigations (same route
// name), so an in-place pod change must tear down the old exec session and
// reset the form — otherwise the terminal stays bound to the previous pod.
watch(
  () => props.object.metadata?.uid,
  () => {
    stop()
    // Clear the previous pod's exec error too: stop() tears down the session
    // but leaves errorMessage set, so a failed-exec banner (e.g. RBAC denied)
    // would linger on the new pod's pristine terminal form until Start resets it.
    session.errorMessage.value = null
    command.value = DEFAULT_COMMAND_LINE
    container.value = defaultContainerName(props.object)
  },
)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-2">
    <div class="flex flex-wrap items-center gap-3 text-sm">
      <div v-if="soleContainer !== null" class="flex items-center gap-1.5">
        <span class="shrink-0 text-slate-500 dark:text-slate-400">Container</span>
        <span
          class="rounded-full bg-slate-100 px-2.5 py-0.5 font-mono text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300"
        >{{ soleContainer }}</span>
      </div>
      <ContainerSelect
        v-else
        v-model="container"
        :object="object"
        :disabled="started"
        :title="lockedHint"
      />
      <!-- Not a <label>: the accessible name is the combobox's own aria-label,
           and a label wrapping the popup's toggle button would forward its
           click into the field. -->
      <div class="flex items-center gap-1.5">
        <span class="shrink-0 text-slate-500 dark:text-slate-400">Command</span>
        <EditableCombobox
          v-model="command"
          :options="COMMAND_SUGGESTIONS"
          label="Command"
          :disabled="started"
          placeholder="/bin/sh -c …"
          :title="lockedHint"
          class="w-64"
        />
      </div>
      <BaseButton v-if="!started" variant="primary" @click="start">Start terminal</BaseButton>
      <BaseButton v-else variant="danger" @click="stop">Disconnect</BaseButton>
      <span class="text-xs text-slate-400">
        {{ session.status.value === "ready" ? "● connected" : session.status.value }}
      </span>
    </div>

    <div
      v-if="session.errorMessage.value !== null"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
    >
      <p>{{ session.errorMessage.value }}</p>
      <p v-if="missingBinaryHint !== null" class="mt-1 font-mono text-xs opacity-90">
        {{ missingBinaryHint }}
      </p>
    </div>

    <div v-if="started" class="min-h-0 flex-1">
      <TerminalView
        ref="terminalRef"
        @data="session.sendInput"
        @resize="session.sendResize"
      />
    </div>
    <p v-else class="p-6 text-sm text-slate-400">
      Press “Start terminal”. The default Auto command
      runs whichever shell the image has (bash when present, otherwise sh) and
      sets TERM=xterm-256color; the field is editable and takes any argv, quoted
      but never expanded — it is not a shell. RBAC (pods/exec) is enforced by
      the cluster.
    </p>
  </div>
</template>
