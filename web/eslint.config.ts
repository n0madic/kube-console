import pluginVue from "eslint-plugin-vue"
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript"

// Flat config for the Vue 3 + TypeScript SPA. Type checking itself is owned by
// `vue-tsc --noEmit` (see the `typecheck` script); ESLint here catches logic
// bugs and Vue-template mistakes that the type-checker does not.
export default defineConfigWithVueTs(
  {
    name: "app/files-to-lint",
    files: ["**/*.{ts,mts,vue}"],
  },
  {
    name: "app/files-to-ignore",
    ignores: ["dist/**", "coverage/**"],
  },
  pluginVue.configs["flat/essential"],
  vueTsConfigs.recommended,
  {
    name: "app/rule-overrides",
    rules: {
      // Unused locals/params are already enforced by tsconfig
      // (noUnusedLocals / noUnusedParameters) via vue-tsc, which honors the
      // leading-underscore convention for intentionally-unused args. Keeping
      // this on here would double-report and conflict with that convention.
      "@typescript-eslint/no-unused-vars": "off",
      // "Sidebar" is an established, unambiguous single-word component name.
      "vue/multi-word-component-names": ["error", { ignores: ["Sidebar"] }],
    },
  },
)
