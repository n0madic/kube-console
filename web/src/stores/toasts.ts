// Toast notifications: transient, in-memory only.

import { defineStore } from "pinia"
import { ref } from "vue"

export interface Toast {
  id: number
  kind: "info" | "success" | "error"
  message: string
}

let nextId = 1

export const useToastStore = defineStore("toasts", () => {
  const toasts = ref<Toast[]>([])
  // Auto-dismiss timers, kept so a manual dismiss cancels the pending timeout
  // instead of leaving it to fire (and accumulate) later.
  const timers = new Map<number, ReturnType<typeof setTimeout>>()

  function push(kind: Toast["kind"], message: string, timeoutMs = 5000): void {
    const id = nextId++
    toasts.value.push({ id, kind, message })
    if (timeoutMs > 0) {
      timers.set(id, setTimeout(() => dismiss(id), timeoutMs))
    }
  }

  function dismiss(id: number): void {
    const timer = timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(id)
    }
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  return { toasts, push, dismiss }
})
