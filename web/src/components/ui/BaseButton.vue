<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "danger" | "ghost"
    type?: "button" | "submit"
    disabled?: boolean
  }>(),
  { variant: "secondary", type: "button", disabled: false },
)

const variantClasses: Record<string, string> = {
  primary:
    "bg-blue-600 text-white hover:bg-blue-500 disabled:bg-blue-300 dark:disabled:bg-blue-900",
  secondary:
    "bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 " +
    "dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600 dark:hover:bg-slate-700",
  danger: "bg-red-600 text-white hover:bg-red-500 disabled:bg-red-300 dark:disabled:bg-red-900",
  ghost:
    "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
}
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
    :class="variantClasses[variant]"
  >
    <slot />
  </button>
</template>
