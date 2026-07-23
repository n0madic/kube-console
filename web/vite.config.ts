import { fileURLToPath, URL } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"

// Dev proxy sends API traffic to the Go backend; ws:true is required for the
// exec WebSocket bridge.
const backend = "http://localhost:8080"

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/k8s": { target: backend },
      "/api": { target: backend, ws: true },
      "/healthz": { target: backend },
      "/readyz": { target: backend },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
})
