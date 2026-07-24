import { fileURLToPath, URL } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"

// Dev proxy sends API traffic to the Go backend; ws:true is required for the
// exec WebSocket bridge. The literal, not "localhost": `make run-dev-auth` must
// bind 127.0.0.1 only (the credential mode's loopback fence), and Node resolves
// localhost verbatim — ::1 first on most hosts — so a name here costs a refused
// connect on every proxied request, or fails outright without Happy Eyeballs.
const backend = "http://127.0.0.1:8080"

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
