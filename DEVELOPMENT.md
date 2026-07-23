# Development guide

Developer-facing setup, verification and architecture notes for
kube-console. For what the project is and how to deploy it, see
[README.md](README.md). For the exhaustive architecture reference (written
for AI coding assistants, but detailed enough for humans), see
[CLAUDE.md](CLAUDE.md).

## Prerequisites

- Go ≥ 1.26 (the module pins `go 1.26.5`; the Docker build uses
  `golang:1.26-alpine`)
- Node ≥ 22 (the Docker build uses `node:26-alpine`)
- A kubeconfig pointing at a cluster — only its server URL and CA are read;
  credentials are always stripped

## Local development

```bash
# terminal 1 — backend on :8080
make run-dev                     # uses $KUBECONFIG or ~/.kube/config

# terminal 2 — frontend with hot reload on :5173
cd web && npm install && npm run dev
```

`npm install` must run **inside `web/`** — an install at the repo root once
created a second `@codemirror/state` copy in the bundle and broke the YAML
editor at runtime ("multiple instances of @codemirror/state").

The Vite dev server proxies `/k8s`, `/api` (WebSocket included), `/healthz`
and `/readyz` to `localhost:8080`. Sign in with any token the cluster
accepts, e.g.:

```bash
kubectl create token default --duration=1h
```

## Building

Production-style build (SPA embedded into a single binary):

```bash
make go-build && ./bin/kube-console --api-server=https://<apiserver> --ca-file=<ca.crt>
```

Docker image:

```bash
docker build -t kube-console:dev .
```

Both stages run on the build platform and cross-compile (`--platform=$BUILDPLATFORM`
plus `GOOS`/`GOARCH`), so any `--platform` target costs one native compile and
needs no emulation — including an amd64 image built on Apple Silicon, which
used to crash Go under Rosetta.

## Verification

Run before claiming any change done:

```bash
make verify        # go vet + go test + eslint + vue-tsc + vitest
```

Individual pieces:

```bash
make vet                      # go vet
make go-test                  # go test -count=1
cd web && npm run lint        # ESLint (flat config, Vue 3 + TS)
cd web && npm run lint:fix    # auto-fix where possible
cd web && npm run typecheck   # vue-tsc --noEmit
cd web && npm test            # vitest run
```

Use the Make targets rather than a bare `go vet ./...` / `go test ./...`: once
`npm install` has run in `web/`, some npm packages ship Go sources without a
`go.mod` (e.g. `flatted/golang`) and `./...` pulls them into the build. The
Makefile filters them out (`GO_PACKAGES = go list ./... | grep -v
'/node_modules/'`); CI is unaffected because its Go job never installs the
frontend.

Single tests:

```bash
go test ./internal/gateway/ -run TestCheckPath -count=1
cd web && npx vitest run src/utils/__tests__/ringBuffer.spec.ts
```

Helm chart:

```bash
make helm-lint      # helm lint + template
```

Live smoke tests against a real cluster should stay **read-only**
(list/logs/metrics; no cluster mutations; exec needs explicit permission). Get
a short-lived token:

```bash
kubectl --context <your-context> create token <serviceaccount> -n <namespace> --duration=10m
```

(minimum duration is 10m)

## Testing conventions

- **Go**: fake upstreams via `httptest` plus hand-built `kube.Upstream`
  values; exec tests dial a real WebSocket against `httptest` with an
  injected `ExecutorFactory` fake. Leak tests assert sentinel tokens never
  appear in logs or errors.
- **Frontend**: vitest + jsdom. `web/src/test/setup.ts` polyfills
  localStorage/sessionStorage (Node ≥ 22 shadows jsdom's), ResizeObserver
  (needed by `@tanstack/vue-virtual`) and matchMedia (uPlot calls it at import
  time, so any test whose import graph reaches a chart needs it); component
  tests stub `getBoundingClientRect` so the virtualizer renders rows.
- Every new feature needs tests; every bug fix needs a regression test.

## Manual E2E checklist

1. Login with a Kubernetes token succeeds and shows the identity.
2. A read-only token sees data but receives the native Kubernetes 403 on
   write operations.
3. A CRD with `additionalPrinterColumns` renders as a generic table with its
   custom columns.
4. Generic YAML apply (server-side apply, `fieldManager=kube-console`) works;
   dry-run validates without persisting.
5. Pod logs follow mode streams live output.
6. Pod exec works for a user with `pods/exec` permission.
7. Raw `/k8s/.../exec`, `/attach`, `/portforward`, `/proxy` are blocked
   (JSON 403, never HTML).
8. With Metrics Server installed: Pod/Node CPU and memory charts render, and
   the Overview cluster summary gauges (CPU, Memory, Pods, Nodes) show usage.
9. With Metrics Server absent/forbidden: the UI shows the corresponding
   explicit state instead of an empty chart; the CPU/Memory gauges show `—`
   while Pods/Nodes still render from the node list.
10. Browser refresh keeps the tab session (token in sessionStorage with an
    8-hour TTL); closing the tab or TTL expiry requires a new login. UI
    preferences persist independently in localStorage.
11. Kind-specific header actions appear only for their kinds (Deployment →
    Scale/Restart, DaemonSet → Restart, CronJob → Trigger now + Suspend/Resume
    matching `spec.suspend`, Node → Cordon/Uncordon matching
    `spec.unschedulable`); on a read-only token confirming one shows the
    native 403 in the dialog and the dialog stays open.
12. The backend scales to multiple replicas without session affinity.

## Architecture

```text
Browser SPA (Vue 3, in-memory bearer token per cluster context)
  ├─ /k8s/*            → constrained Kubernetes API gateway (raw passthrough)
  ├─ /api/ui/*         → small adapters: contexts, auth verify, discovery, metrics
  └─ /api/ui/exec/ws   → WebSocket bridge for pod exec (client-go remotecommand)

Go backend
  ├─ static SPA via go:embed
  ├─ registry of credential-free TLS transports, one per kubeconfig context
  │  (selected per-request by the X-Kube-Context header; default when absent)
  ├─ httputil.ReverseProxy per context with path allowlist + header sanitization
  ├─ discovery adapter (aggregated discovery with legacy fallback)
  ├─ Metrics Server adapter (CPU/memory only, no history)
  └─ exec bridge (WebSocket executor, SPDY fallback)
```

All resource CRUD, watch, Table responses, selectors, pagination and
server-side apply go through the `/k8s/*` gateway with native Kubernetes API
semantics — new built-in resources, CRDs and aggregated APIs work
automatically, with no per-resource backend or frontend code.

Backend wiring: `cmd/kube-console/main.go` → `config.Load` (flags > env >
defaults) → `server.Run` builds `kube.NewRegistry` (a map of shared
credential-free upstreams + default) → `server/routes.go` +
`server/adapters.go` mount everything. See CLAUDE.md for the full request-path
and per-feature breakdown (multi-cluster session handling, metrics caching,
field-tree rendering heuristics, related-resources cards, etc.) — it's kept
up to date alongside the code and is the deeper reference this file
intentionally doesn't duplicate.

## Gotchas

- Tailwind: never put a static text-color utility on an element that also
  gets a conditional one — stylesheet order decides the winner, not class
  order (this once made red `Failed` statuses render neutral). Pick the full
  class in one expression.
- `vite build` empties `web/dist`; `web/dist/.gitkeep` must exist for
  backend-only builds (the Makefile re-touches it).
- Status color-coding applies only to status-bearing columns
  (`isStatusColumn`), otherwise names like "error-page" light up red.
- The gateway blocklist makes objects literally named `exec`/`attach`/
  `portforward`/`proxy` unreachable — known limitation, documented in
  README.
- CodeMirror (`CodeMirrorEditor.vue`, ~110 kB gz) is imported via
  `defineAsyncComponent` in YamlTab/EditYamlDialog/CreateResourceDialog so it
  loads only when the YAML tab or an edit/create dialog opens — never on the
  default Overview detail view. Keep it lazy (no static import) and keep the
  hand-picked extension set instead of `basicSetup` (which pulls autocomplete/
  lint/search we don't use). Code folding IS kept — it's cheap (rides on the
  already-bundled `@codemirror/language`) and useful on large manifests.
