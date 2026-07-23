# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project

kube-console — stateless Kubernetes web console. Go backend (module
`github.com/n0madic/kube-console`) serves an embedded Vue 3 SPA and acts as a
**credential-free constrained reverse proxy** to the kube-apiserver.

## Commands

```bash
make verify            # go vet + go test + eslint + vue-tsc + vitest (run before claiming done)
make go-build          # builds web/dist then the binary with SPA embedded → bin/kube-console
make run-dev           # backend on :8080 using $KUBECONFIG (credentials stripped)
cd web && npm run dev  # Vite dev server on :5173, proxies /k8s,/api(ws),/healthz,/readyz to :8080

# Single tests
go test ./internal/gateway/ -run TestCheckPath -count=1
cd web && npx vitest run src/utils/__tests__/ringBuffer.spec.ts

make helm-lint         # helm lint + template
docker build -t kube-console:dev .  # any --platform: both stages cross-compile from the host arch
```

- CI (`.github/workflows/ci.yml`; `master`, `v*` tags, PRs): parallel Go
  (`test -race`), Frontend and Helm jobs, then an image job gated on all three
  (`linux/amd64,linux/arm64` → `ghcr.io/n0madic/kube-console`; tags from
  `docker/metadata-action`, `latest` only on `v*`). PRs build but never push —
  a fork PR has no package credentials.
- A `cleanup` job prunes ghcr.io after every push that published. `sha-*` is
  the only tag family it deletes (newest 10 kept, `keep-n-tagged` scoped by
  `delete-tags`); release tags are `1.2.3`/`1.2` — the leading `v` is stripped
  by `docker/metadata-action` — and are out of that scope, `latest`/`master`
  are excluded outright. It must stay `dataaxiom/ghcr-cleanup-action`, which
  walks manifest lists: GHCR lists the platform children of a multi-arch image
  as untagged versions, so purging "untagged" by hand (GHCR UI,
  `actions/delete-package-versions`) deletes the children of live tags and
  makes `docker pull` fail with `manifest unknown`. `delete-ghost-images`/
  `delete-partial-images` clean up after exactly that; `validate: true` fails
  the job if a surviving image lost a child.
- `npm install` must run **inside `web/`** — a root install once duplicated
  `@codemirror/state` in the bundle and broke the YAML editor at runtime
  ("multiple instances of @codemirror/state").
- Go targets run over `GO_PACKAGES` (`go list ./... | grep -v '/node_modules/'`),
  not a bare `./...`: once the frontend is installed, npm packages that ship Go
  sources without a `go.mod` (e.g. `flatted/golang`) land in `./...` and break
  vet/test. Use `make vet` / `make go-test` locally; CI's Go job never installs
  the frontend, so it is unaffected.
- Live smoke against a real cluster is **read-only** (list/logs/metrics; no
  mutations; exec needs explicit permission). Token: `kubectl --context <ctx>
  create token <serviceaccount> -n <namespace> --duration=10m` (10m is the
  minimum).

## Security invariants (do not weaken)

**Zero backend credentials.** `kube.anonymize` on **every** per-context config
(`internal/kube/restconfig.go`, `registry.go`); the Helm chart creates no
RBAC/SA and sets `automountServiceAccountToken: false`. The user's bearer is
forwarded per-request via a request-scoped cloned RoundTripper
(`kube.WithBearer`); the shared transport is never mutated.

`rest.AnonymousClientConfig` alone is **not** the whole invariant: it drops
BearerToken/Username/Password/client certs but copies `Host` verbatim, so
`server: https://user:pass@apiserver` (or the same in `--api-server`) survives
it. That is not cosmetic — client-go's `http.Client` turns URL userinfo into an
`Authorization: Basic` header and its bearer round tripper refuses to overwrite
an Authorization that is already set, so the operator's credentials would go
upstream *instead of* the user's token (exec builds its URL straight from
`Host`), and the same URL is printed at startup. Hence `stripHostCredentials`
next to it, dropped again in `parseHost` (`transport.go`) so `Upstream.BaseURL`
— what is proxied to, probed and logged — is credential-free whichever path
built it, `parseHostURL` keeping the raw host out of parse errors (`url.Error`
stringifies the URL it failed on), and `BaseURL.Redacted()` at the log site.
A kubeconfig `proxy-url` **keeps** its userinfo: it authenticates kube-console
to the operator's egress proxy, goes only into `Proxy-Authorization` on the
CONNECT hop, never reaches the apiserver or a client, and is never logged.

**Multi-cluster is per-context, credential-free.** `internal/kube/registry.go`
holds one anonymous `kube.Upstream` per kubeconfig context; a request selects
one with `X-Kube-Context` (`kube.ContextHeader`). The value is **only ever a
registry key** — never interpolated into a URL — and an unknown name fails
closed with `400` before any upstream is contacted. One bearer per cluster.

**Gateway `/k8s/*`** (`internal/gateway`): allowed roots `/version /api /apis
/openapi`; segments `exec|attach|portforward|proxy` blocked at any depth (`log`
allowed); `%2F`, dot-segments and inbound Upgrade rejected; Cookie/Forwarded/
Referer/Origin/`X-Kube-Context` stripped exactly (`exactStripHeaders`),
`Impersonate-*`/`X-Remote-*`/`X-Forwarded-*` by prefix (`prefixStripHeaders`) —
both in `sanitize.go`, leak-tested. Upstream errors pass through with native
Kubernetes `Status` bodies.

**Exec runs ONLY through the WebSocket bridge** (`internal/exec`):

- Auth is the first text frame (≤64KiB, 2s deadline), never URL/query/
  subprotocol; it also carries the context (`AuthFrame.Context`,
  printable-ASCII ≤253, resolved via the registry). The per-connection
  `rest.Config` copy is transient.
- A **session** slot is taken only once that frame validates and its context
  resolves; until then the connection holds a bounded `pending` slot
  (`handshakePoolFactor`×`MaxExecSessions`), returned in one step exactly when
  the session slot is taken (`releaseHandshake`, a `sync.OnceFunc`). Taking the
  session slot at accept time let anyone with no token and no Origin hold every
  slot with bare handshakes; the split makes `MaxExecSessions` a limit on
  *using* exec, not on connecting. At the limit a client gets an error frame +
  close 1013 after its auth frame, not an HTTP 503 at dial.
- `ipGate` (`limits.go`, `--max-exec-handshakes-per-ip`, **off by default** —
  see abuse limits) caps *pending* connections per client IP and deliberately
  not established ones: without `--trusted-proxies` a whole team shares one
  address, so capping open terminals breaks the console for everyone, while a
  handshake lives ≤2s. The `pending` pool bounds things either way.
- Teardown: client gone → `readLoop` ends → queued stdin drains → `stdinPump`
  closes stdin; `awaitStream` gives a command that ends on EOF `drainTimeout`
  (2s) to close the upstream stream itself, then cancels. **An interactive shell
  on a TTY does not exit on stdin EOF** (the kubelet keeps the pty open), so
  cancelling is the normal outcome — as with kubectl, whose departing client
  just drops the connection and lets the kubelet reap the process. Keep the
  timeout short: it is delay before an unavoidable drop, with the session slot
  held meanwhile.
- Cancelling closes the upstream under client-go's own copy goroutines, which
  narrate it through klog at error level ("Copying stdout failed" / "Waiting for
  server to close stdin failed" / "Websocket Ping failed", all "use of closed
  network connection") on every closed terminal. Hence `debugLogr(h.logger,
  &quiet)` (`logging.go`) on the session context: a slog-backed logr demoting
  client-go to debug, dropping anything deeper than klog V(4) (V(8) logs a line
  per keystroke; V(6)+ also switches client-go's debugging RoundTripper into
  URL/curl logging), and **silent** once `quiet` is set — `awaitStream` sets it
  when the client is gone, `end` on idle/ping/shutdown cancels; past that point
  no error frame can reach anyone anyway. Real failures still return from
  `StreamWithContext`.
- `pingLoop` stops cancelling once `clientGone` is closed, so a ping failure
  cannot land inside the grace period and force the abrupt path. `readLoop` only
  reads the socket; the blocking stdin-pipe write lives in `stdinPump` behind a
  bounded queue (`stdinQueueDepth`) — a reader parked in that write sees neither
  the client leaving nor a pong, and coder/websocket's `Ping` needs a concurrent
  `Reader` to receive its pong, so healthy sessions were being killed.

**Tokens are never validated before forwarding** — the apiserver judges. That
keeps the backend stateless, and it means whoever can reach kube-console can
reach the apiserver at the request level (they get its own 401, but the network
hop is theirs). Hence the abuse limits:

- Only `--max-in-flight` is on by default: it is the only cap **not keyed by
  client address**. `--rate-limit` and `--max-exec-handshakes-per-ip` default to
  **0 (off)** — they can only tell clients apart when clients arrive with
  distinct addresses, and every deployment kube-console is built for (ingress,
  VPN, authenticating proxy) collapses the team onto one. A shared per-IP budget
  then denies an attacker nothing (inside the perimeter they hold everyone's
  key) while one busy tab spends the team's allowance and 429s the rest. Do not
  "restore" them as defaults; enable them where clients are genuinely
  distinguishable (no perimeter, or a proxy forwarding per-client XFF with its
  CIDRs in `--trusted-proxies`). `server.Run` logs the effective set (`abuse
  limits`) at startup, so what is in force is never inferred from missing 429s.
- `httpx.ClientIPResolver`/`ClientIP`: RemoteAddr by default, `X-Forwarded-For`
  **only** for `--trusted-proxies` CIDRs (a client-supplied header would buy a
  fresh bucket per request), IPv6 bucketed by /64. The **peer** is checked
  against those CIDRs before the header is read at all (`peerIn`), because chi's
  `ClientIPFromXFF` looks only at the header: traffic arriving off-ingress
  (Service, NodePort, port-forward, any pod) could otherwise name its own
  limiter key per request. Off-proxy peers key by RemoteAddr.
- `internal/server/limits.go` spends the resolved IP on one shared `httprate`
  budget (`--rate-limit`, per client per minute) alongside the
  address-independent concurrency cap (`--max-in-flight`). Both are mounted on
  `/k8s/*` **and** `/api/ui/*` — one limiter instance each, so the prefixes
  cannot be alternated to spend a budget twice — and outermost, ahead of body
  limits and dispatch, so a shed request costs only the check.
- The in-flight cap routes what is long-lived by design (`gateway.IsStreaming`,
  exec WS via the `execWSPath` const shared with the route registration) into a
  **separate** pool of `streamPoolFactor`×`MaxInFlight`: counting watches
  against the unary cap fills it with idle streams and starves short requests,
  but exempting them made the cap opt-out — "long-lived" is a client-supplied
  `?watch=true`, and a rate limit bounds only rate. A slot is held for all of
  `next.ServeHTTP`, response copy included, so the cap works only because
  `WriteDeadline` (below) bounds a stalled write; otherwise a caller takes all
  128 unary slots with responses it never reads, far inside even an enabled rate
  limit. `server.Run`'s `abuse limits` line therefore also carries
  `responseWriteTimeout`.
- Probes and the SPA are never rate limited (a 429 on `/readyz` restarts the
  pod). The two paths answering *without* asking the apiserver are gated by hand
  — exceptions to "adapters are thin": `/api/ui/contexts` verifies with
  `auth.VerifyToken`, `/readyz` caches (`internal/server/readiness.go`, 5s TTL,
  probe under the mutex so a burst collapses onto one upstream call, on a
  background context so one caller giving up cannot fail everyone).

**`auth.VerifyToken`** (`internal/auth`) is the single SelfSubjectReview call,
shared by `POST /api/ui/auth/verify` and `GET /api/ui/contexts`;
`auth.WriteError` maps `ErrInvalidToken`→401 (the status the SPA's logout path
keys on), everything else→502. A 403 means the token is valid but may not
introspect itself (`IdentityUnavailable`) and must never block the caller. No
token cache and no session state: a cached verdict drifts from what the
apiserver would decide next, and anything derived from a token reintroduces
credential state.

**Discovery forwards the upstream verdict, not a generic 502**
(`internal/discovery/handler.go`, `statusError`): 401 stays 401 — otherwise a
token expiring mid-session makes discovery answer 502, the SPA's 401→logout
path (`api/http.ts`) never fires and the sidebar just breaks — and 403 stays
403, because a cluster that unbinds `system:discovery` from
`system:authenticated` is an RBAC denial, not an unreachable apiserver, and a
502 sends the operator chasing network problems. Everything else is the 502.

**Logs never contain headers, bodies or query strings** (RequestLogger).

**Frontend token storage.** Bearer tokens live in tab-scoped `sessionStorage`
(`kube-console.session.v1`, absolute 8h TTL — a deliberate relaxation of the
original re-login-on-every-refresh design, per owner decision), **one per
context** in a single record
(`{ activeContext, sessions: { <ctx>: {...} } }`). They must NEVER reach
localStorage; `preferences.ts` persists via an explicit allowlist serializer
only. Exactly **one** end-of-session path, `clearSession(context)`: it drops
that one context's record and serves Sign out (`clearActiveSession()`), the
401 handler and the TTL guard alike, so ending one cluster's session never wipes
another's token or chart history. It takes the context **explicitly** because
the 401 handler is usually reached by a response that outlived the cluster it
was sent to — see "following the active cluster". The active context **name**
survives sign-out (it is not a switch), so the login page names the cluster and
a still-valid default session is not orphaned.

Everything fetched with a session dies with it, in **one** place:
`evictContextCaches(context)` (`stores/auth.ts`) drops that context's metric
buffers (`clearMetricsCacheContext`) *and* its cached responses, and both
`clearSession` and `pruneExpiredSessions` call it — so Sign out, a 401 and TTL
expiry cannot diverge. The query prune is injected (`setQueryPruner`, wired in
`main.ts` to a context-scoped `removeQueries`, never `queryClient.clear()`)
because the QueryClient is built there and a store must not import the app
instance — the same reason `api/http.ts` takes its handlers by injection. It
lives in the store rather than in the callers because that is exactly what
drifted before: query pruning wired only into Sign out and the 401 handler left
an expired session's responses cached until the next sign-out, and since the
Pod Env tab caches ConfigMap/Secret payloads (see "Detail pages"), that was
Secret data outliving the token that read it. A predecessor
`auth/endSession.ts` wrapper is gone — with eviction in the store it was a pure
duplicate of `clearSession`/`clearActiveSession`.

**Expired means gone, not hidden.** `hasSession`/`signedInContexts` only *read*
the TTL (a lazy check, never a reactive clock — and they are called from
computeds, which must not mutate); dropping is `pruneExpiredSessions()`, called
where a session is about to be used or picked (`getBearerToken`,
`setActiveContext`, the route guard) and matched by the restore path at startup.
Otherwise the token string sits in sessionStorage — readable by any same-origin
script — until a reload. `isAuthenticated` checks the TTL too: a token alone is
not authentication, or switching to a stale context flashes past the login guard
as authorized. A restore that drops expired/tampered entries rewrites
sessionStorage immediately; tests assert all of this with sentinel tokens.

The only other stored UI state is the selected namespace
(`kube-console.namespace.v1`, `stores/ui.ts`, tab-scoped, non-sensitive, never
localStorage).

**Kubernetes data is always rendered as escaped text** (no `v-html`).

## Architecture

### Request paths

`/k8s/*` → raw constrained proxy (all CRUD/watch/Table/SSA semantics are native
Kubernetes; no per-resource backend code) · `/api/ui/*` → small adapters
(contexts, auth verify, discovery, metrics, exec WS) · everything else →
embedded SPA (`web/embed.go`, package `web` at the repo root because go:embed
cannot reference `../` — deliberate deviation from all-code-in-internal). The
SPA fallback never serves HTML for `/k8s/*` or `/api/*` (JSON errors only), so
blocked paths cannot look like 200s. The check runs on a `path.Clean`ed path
(`static.go`): chi does not normalize, so `//api/ui/discovery` and
`/api/../api/ui/discovery` reached the fallback as non-API paths and answered
`index.html` with a 200.

### Multi-cluster

Every path resolves its upstream per-request from `X-Kube-Context` via
`registry.Resolve` (empty → default; unknown → `400`). The gateway pre-builds
one `httputil.ReverseProxy` per context (`rewriteFor(base)`, `Transport:
up.Transport`) and dispatches after method/upgrade/bearer/`CheckPath` validation.

`GET /api/ui/contexts` returns context **names** + default only (URLs and CAs
are never exposed) and verifies the bearer with `auth.VerifyToken` first: names
describe the estate (environments, account ids in EKS-style names), and an
`Authorization` header proves nothing — `Bearer junk` used to enumerate every
cluster. One SelfSubjectReview per fetch; the SPA fetches once per session
(`staleTime` 5m). `POST /api/ui/auth/verify` echoes the **resolved** context
name (`VerifyResponse.Context`) so the SPA, which has no context list on the
very first login, knows what to store the session under. `/readyz` probes only
the **default** context (one reachable apiserver is enough to be ready) and,
being unauthenticated, caches the outcome.

### Page title

The contexts response also carries the optional `clusterName`
(`--cluster-name`/`KUBE_CONSOLE_CLUSTER_NAME`, `config.Config.ClusterName`, ≤64
runes, no control characters) — on that authenticated endpoint, not a public
one, because a cluster label describes the estate exactly like the names beside
it. `document.title` is `<cluster> · kube-console`, set by `usePageTitle` (in
`App.vue`) off the pure `utils/pageTitle.ts`: the configured name when set — for
**every** context, which is what makes it useful in-cluster — else the active
context, except that names identifying no cluster (`default`,
`kubernetes-admin@kubernetes`, … — `GENERIC_CONTEXTS`) yield a bare title.
`usePageTitle` takes `useContextsQuery` (the bare query split out of
`useContexts`) so the reconcile watch still runs only in the switcher.

### Cluster switcher

`ClusterSelector.vue` (shown only when >1 context, same rule as the login
picker) is a thin wrapper over the presentational
`components/ui/ContextListbox.vue`, with rows from `utils/contextItems.ts`
(`contextItems(names, hasSession)`: dedupe, drop `""`, **sort by name**, stamp
`signedIn`). Both are shared with the login page so the pickers match — the
login page unions several unordered sources, so only a total order can make them
agree; kubeconfig order is deliberately not preserved. A "signed in" badge
(`auth.hasSession(name)`, lazy TTL check — no reactive clock) shows up front
which switch goes straight over and which lands on `/login`.

It is a **custom listbox**, not a `<select>`, because a native popup caps its
height and scrolls at the browser's discretion; the panel is an absolute `ul`
(`max-h-[70vh]`). The highlighted index is clamped to the item count on read, so
a shrinking list cannot strand it. The trigger is ARIA's **select-only
combobox** (`role="combobox"`, `aria-controls`/`aria-activedescendant`,
per-option ids from `useId()` so two mounted pickers never collide): focus stays
on the trigger, and the combobox role is what makes the button's text read as
the *value* — under a plain button role `aria-label` would swallow the selected
cluster name.

### Backend wiring

`cmd/kube-console/main.go` → `config.Load` (flags > env > defaults; own settings
use `KUBE_CONSOLE_*`, spec-fixed `KUBE_API_SERVER`/`KUBE_CA_FILE`) →
`server.Run` builds `kube.NewRegistry` (shared credential-free upstreams +
default) → `server/routes.go` + `server/adapters.go` mount everything.

Enumeration (`kube.RESTConfigs`, in precedence order): explicit `--api-server` →
explicit `--kubeconfig` (+ optional `--context`) → in-cluster
(`config.applyInClusterDefaults`: host from `KUBERNETES_SERVICE_HOST`/`PORT`, CA
from the mounted `serviceaccount/ca.crt` if present — the token is never read) →
standard kubeconfig discovery (`$KUBECONFIG`, `~/.kube/config`) → clear error.
Only a multi-context kubeconfig yields more than one upstream (all contexts are
enumerated; `--context` picks the default, all stay switchable);
`--api-server`/in-cluster synthesize a single `default` context. A broken
**non-default** context is warned + skipped; a broken **default** one is a hard
error. `anonymize` (`rest.AnonymousClientConfig` + `stripHostCredentials`)
strips credentials on every path, so the zero-credential invariant holds
regardless of source. The Helm chart needs no
connection config: the host is derived in-cluster, the CA defaults to the
auto-published `kube-root-ca.crt` ConfigMap (public cert, no SA token).

### Write deadline and shutdown

No `http.Server` WriteTimeout and no client timeouts on the shared transport:
watch/log streams are long-running. Instead `WriteDeadline`
(`internal/server/middleware.go`, `Config.ResponseWriteTimeout`, 30s, no flag, 0
disables) wraps the root router and re-arms the connection's write deadline
before **every** write. A total write timeout would kill watches, log follows
and large downloads (a "download all" pod log is `/log` *without* `follow`, so
it is unary and can reach the kubelet's retention); a per-write one only asks
the client to keep accepting data, and is inert for an idle stream, which writes
nothing and so arms nothing. Three load-bearing details, each with a regression
test:

1. It **re-arms when the handler returns** (`deadlineWriter.finish`): net/http
   writes the chunked terminator in `finishRequest` *after* the handler and
   *before* resetting the deadline itself, so an expired deadline left in place
   truncated every stream that had gone quiet — `unexpected EOF` instead of the
   clean end of body that is the normal ending of an idle watch or log follow.
   Clearing it instead would leave that flush unguarded.
2. `Hijack` disarms **after** delegating, on the `net.Conn` it is handed, never
   before: `(*response).Hijack` flushes the already-written 101 *first*, so
   clearing early reopens the very stall this prevents, on the exec path.
   net/http's `hijackLocked` clears both deadlines anyway, so this is
   belt-and-braces.
3. `Flush` arms too, not just `Write` — a flush is where buffered bytes reach
   the socket, and it only follows a write inline because the gateway sets
   `FlushInterval: -1`; any positive interval flushes from a timer goroutine.

Re-arming is skipped while more than half the budget is still ahead of the armed
deadline (no syscall per 32KiB chunk), so the effective bound on a stalled write
is `[timeout/2, timeout]`. A drop is logged (`client stopped reading`,
method/path only, once per response) because the abort path is otherwise silent:
the ReverseProxy panics with `http.ErrAbortHandler`, `Recoverer` re-panics it
and `RequestLogger` logs only after `ServeHTTP` returns.

Shutdown (`server.Run`, SIGINT/SIGTERM) grants a fixed 15s `srv.Shutdown()`
before an unconditional `srv.Close()`, but streams need not ride it out:
`Deps.ShutdownCtx` is threaded through `AbortOnShutdown` (same file), which
wraps the `/k8s/*` gateway handler (matched via `gateway.IsStreaming` —
`watch=true` or `.../log?follow=true`, parsed with the apiserver's own boolean
semantics) and unconditionally wraps `/api/ui/exec/ws`. It cancels those
contexts the instant shutdown starts — the ReverseProxy's `errorHandler` already
treats `context.Canceled` as a silent client-gone case — so `srv.Shutdown()`
only waits for ordinary short requests.

### Frontend: following the active cluster

Everything hangs off **context-scoped keys**: `auth.activeContext` is part of
the vue-query keys (`["discovery", ctx]`, `["namespaces", ctx]`, list keys) and
of the `useResourceList`/metrics watch deps, so a switch rebuilds sidebar/lists/
watch/charts under the new cluster and in-flight responses from the old one are
dropped — no forced purge, and old-cluster data stays cached for an instant
switch-back. `metricsCache` scopes are prefixed `<ctx>:`. `apiFetch` stamps
`X-Kube-Context` from `CredentialProvider.getContext()`; exec carries it in the
auth frame.

Old-cluster requests are **not** aborted on switch — they are simply not
awaited for their data. But their *failures* still ran global side effects, so
`apiFetch` carries the request's own context into the 401 / unknown-context
handlers (see "Auth abstraction"): the scenario is a request to A in flight →
switch to B → A answers 401 → B's token was deleted.

Switching to an authorized context keeps the place (`resource-list`/Overview
stay; `resource-detail` collapses to its list so the object-may-not-exist case
cannot 404 and the detail watch/logs/terminal tear down cleanly); the namespace
is kept if the new cluster has a same-named one, else reset to "all" (reconciled
in `NamespaceSelector` when the new **complete** list loads — a truncated
`limit=500` page with a continue token cannot prove absence and never resets).
Switching to an unauthorized one redirects to `/login` bound to that context
(with a `redirect` back to the current view, collapsed to the list for a detail
page); context-scoped fetchers are gated on `isAuthenticated` (query `enabled`
on discovery/namespaces, guards on the `useResourceList`/cluster-summary
watches) so the switch fires no tokenless requests that would 401 globally.

The login page is never a dead end: its "Cluster context" line is the **same
picker** as the sidebar's, shown whenever more than one name is known (plain
text otherwise). `/api/ui/contexts` needs a bearer for the context that is
precisely missing there, so names are the union of the cached `["contexts"]`
query, `auth.signedInContexts()` (a function, not a computed — the lazy TTL
check must not be cached, and it is the only source surviving a reload) and the
active context itself. The picker is inert while a verify is in flight, since an
in-flight verify ends by activating the context it was started for and would
undo the switch. Picking a signed-in context switches `activeContext` and
follows the `redirect` (same-origin paths only; `//host` would reach
`history.pushState` as an off-site URL); picking another unauthorized one
rebinds the form and clears the previous rejection message. A backend `400`
"unknown cluster context" (removed upstream) resets `activeContext` to the
default's **name** (from cached `["contexts"]` data — `""` would orphan a valid
default session) and refetches; `useContexts`' reconcile likewise drops a
vanished context to the default and routes to `/login` when it has no session.

### Resource layer (fully generic)

The sidebar comes from `/api/ui/discovery` (`utils/resourceCatalog.ts` buckets/
dedupes, hides mirrored `events.k8s.io`). Sections collapse on a header click —
state is in-memory, re-derived per page load: all sections start collapsed when
at least one pin resolves against discovery (the pins are then the entry point),
and a non-empty search box overrides collapse so it cannot hide its own matches.
The Pinned block is drag-reorderable (`movePinned` in `stores/preferences.ts`
moves **by id**, since the visible list may be search-filtered).

Lists use the Kubernetes Table API with a `listToTable` fallback.
`composables/useResourceList.ts` loads the **whole collection** (500-per-page
continue walk, 5000 cap — like `kubectl --sort-by`) so client-side sorting and
filtering cover everything; a watch (Table-typed events, bookmarks, 410→relist,
bounded backoff) keeps it live; beyond the cap it degrades to forward-only
pagination and Enter-triggered server name scans.

`ResourceTable` takes an optional `cellLink(row, column, value)` prop turning a
cell into a RouterLink (`@click.stop`, so it does not also fire the row click).
Its one caller is the **events** list, linking the Object column to the involved
object: the printer emits `<kind>/<name>` lowercased and with **no apiVersion**,
so `parseEventObjectCell` (`utils/eventHelpers.ts`) splits the cell and
`useDiscovery().findByLowerKind` resolves case-insensitively (core group first —
a bare "event" is the core one — then highest version, like the sidebar dedupe);
the namespace comes from the event's row metadata, cluster-scoped kinds (Node
events live in `default`) take the `_` sentinel. `ResourceListPage` memoizes the
resolver per namespace+cell, since the table asks per visible cell on every
render.

Writes go through server-side apply (`fieldManager=kube-console`, force=false,
dry-run supported) — never PUT. The exception is the narrow set of kind-specific
actions (scale, rollout restart, suspend/resume, cordon/uncordon), which send
targeted `PATCH`es like kubectl (`patchObject` in `api/k8s.ts`, merge or
strategic-merge): `spec.replicas` and the restart annotation are usually owned
by another field manager, so SSA with `force=false` would 409 on every click. A
manual CronJob run `POST`s a Job (`createObject`).

### Detail pages

Generic tabs (Overview/YAML) + a kind registry in `ResourceDetailPage.vue`
adding Pod (Env/Logs/Metrics/Terminal) and Node (Metrics) tabs. Every tab is
`v-if`-swapped — **except Terminal**, which owns a live exec session (and a
shell running in the pod): it sits outside that chain, mounts on first use, is
then only hidden with `v-show` while the pod page stays open, and is `:key`ed by
namespace/name so another pod still remounts it. `PodTerminalTab` takes `active`
and refits + refocuses xterm on the way back — `TerminalView.fitNow()` is a
no-op while the host has zero size, because under `display:none` FitAddon reads
the declared "100%" as pixels and would push a ~2x5 resize upstream.

Its Command field is `components/ui/EditableCombobox.vue` — **one** editable
input with a popup of suggestions, never an `<input list>` (a datalist filters
its options by what the field already holds, so the prefilled `/bin/bash` hid
every other suggestion) and never a `<select>` plus a second "custom" input
(two controls for one value). It is hand-built on ARIA's editable-combobox
pattern for the same reason `ContextListbox` is: the popup must not be at the
browser's discretion. The list never filters — it exists to *show* what is on
offer. An **unfocused** field shows the label of the option it currently holds
and reveals the real command line on focus (caret sent to the start after a
pick): the auto shell is a `sh -c` one-liner that otherwise fills the toolbar,
but editing must always start from what actually runs, so the alias never
outlives the moment someone touches it — and `title` carries the command in
either state. Every other preset's label *is* its command line, so only Auto is
ever aliased.

What runs is the field, always: `utils/shellPresets.ts` holds an **argv** per
preset and renders it through `formatCommandLine`, whose round trip with
`parseCommandLine` is a tested property — so a picked suggestion is a starting
point to edit, not a mode. `parseCommandLine` therefore does POSIX-ish
*quoting* (`'…'`, `"…"` with `\"`/`\\`, backslash outside) and **no expansion
whatsoever**: without quoting `sh -c '…'` cannot be typed at all, and with
expansion the field would be pretending to be a shell it never runs.

The default `auto` preset is one `["/bin/sh","-c", …]` resolving the shell
inside the container (`command -v bash … && exec bash; exec sh`, plus `export
TERM=xterm-256color` since exec passes no environment and xterm.js is an
xterm-256color emulator). It replaced a connect/fail/reconnect bash→sh fallback
in the component. Note the POSIX rule it encodes: a non-interactive shell
**exits** when `exec` cannot find its command, so `exec bash || exec sh` would
never reach the sh. A missing-binary error (`isMissingExecutableError`) is
annotated in place: `isAutoCommand` (compared as an argv, so an edited but
equivalent line still counts) decides between "try Auto" and — when even sh is
missing — `debugContainerHint`'s `kubectl debug --target=` line.

`components/pod/ContainerSelect.vue` is the Container picker of **both** pod
tabs (Logs and Terminal): `podContainers` lists regular, then **ephemeral**
(`kubectl debug` containers, the usual exec target on a shell-less image), then
init last, since exec into a finished init container always fails; `<optgroup>`s
appear only when more than one kind is present. Choosing the initial value stays
with the tabs (Logs restarts its stream on every change and must not fire on
mount), but both use `defaultContainerName` — the
`kubectl.kubernetes.io/default-container` annotation when it names a container
of *this* pod (a stale one would preselect a 404), else the first regular one.
With exactly **one** container the picker locks itself (`locked = disabled ||
sole`): a popup that opens onto its own current value is not a choice. It stays
a `<select>` rather than becoming a pill — the toolbars keep one control shape —
and the lock lives in `ContainerSelect`, not in the tabs, so Logs and Terminal
cannot drift apart. Hence `title` is a declared **prop**, not a fallthrough
attribute: both reasons to be locked can hold at once and they differ in what
the user can do about them, so the component picks (the caller's running-session
title wins over its own "The only container in this pod"). Tests must not reach
the tabs' toolbars by select index — `PodLogsTab`'s Tail select is found by
label, since a single-container pod's picker is not the only thing that can move
around it.

Header buttons come from a second registry, the pure `utils/resourceActions.ts`
(`actionsFor` keyed `<apiVersion>/<Kind>`, same convention as
`CHILDREN_BY_OWNER`; Suspend/Resume and Cordon/Uncordon resolve from the
object's current spec); `ResourceActions.vue` renders them and
`ResourceActionDialog.vue` runs the selected one
(confirm, `busy`, native 403 shown in place). Trigger-now builds the Job
manifest exactly like `kubectl create job --from=cronjob/x`. No RBAC gating: a
denial is the native Kubernetes 403, as with Edit YAML/Delete.

The Pod Env tab (`PodEnvTab.vue` + pure `utils/podEnv.ts`) flattens every
container env var — inline, `valueFrom` (ConfigMap/Secret/field/resource) and
bulk `envFrom` — into one globally name-sorted table, resolving ConfigMap/Secret
values from objects it fetches (unreadable ones are marked, never fatal);
kubectl precedence (envFrom first, env overrides). Secret-backed values reuse the
Secret panel's masking.

Those two fetches are vue-query queries, not component state: the tab is
`v-else-if` in `ResourceDetailPage`, so every tab switch remounts it and a
component-local load refetched each time. The key is `["podEnvSource", <ctx>,
<namespace>, configmaps|secrets, <sorted names>]` — context-scoped like every
other query, so `evictContextCaches` prunes it at every end of session, and
canonical (sorted) so two Pods referencing the same objects share one entry.
`staleTime` is a deliberate **60s**, not discovery's 5m: ConfigMap/Secret values
change under a running Pod and the page's Refresh button only refetches the Pod
object, so this is the only bound on how stale a rendered value can be. Two
consequences of caching to keep in mind: Secret `data` lives in the shared
QueryClient (memory only, never storage) past the tab's unmount, until `gcTime`
or the end of the session that read it — this is the query family that made TTL
expiry evict the query cache, not just the token (see "Frontend token storage");
and the empty state keys on **both maps having resolved**, never on
`rows.length` alone — with the queries gated off (`enabled: isAuthenticated`, a
session past its TTL) data stays undefined, and "No environment variables."
would then be a false statement about the Pod.

### Logs

`PodLogsTab` → `LogViewer.vue` is **not** CodeMirror/xterm but a plain
virtualized list (`@tanstack/vue-virtual`, fixed 20px rows) over the
`useLogsStream` line ring: a log stream is an append-only JSONL feed, not a
document — CodeMirror's ~110 kB would have to be un-lazied for the most common
tab, and `lang-json` would flag every line after the first as broken.

The endpoint has **no pagination** (no offset, no continue token), so there is
nothing to "load earlier": a request can only be re-issued with a wider window
(`tailLines`, `sinceSeconds`, `limitBytes`, `previous`). Hence Tail has an
**All** option omitting `tailLines`, `MAX_LINES` is 200k rather than a display
tail, and `useLogsStream` exposes `truncated` so a dropped head is stated, not
silently shown as the whole log. Two further ceilings are the cluster's: the
kubelet rotates container logs (`containerLogMaxSize`/`containerLogMaxFiles`,
10Mi × 5 by default) and keeps only one previous instance. **Download** is the
escape hatch for logs too big for the viewer: never a tail, never followed,
through `apiFetch` (the endpoint needs the bearer, so a plain link cannot work)
and `utils/download.ts`.

Chunks merge into the buffer on a 50ms window (`flush`), not per chunk — a bulk
load arrives as hundreds of chunks and each merge copies the buffer and
re-renders. The staging array is capped like the visible one (a hidden tab keeps
streaming while its timers are throttled), and a finished stream flushes
synchronously so `running=false` never leaves lines staged.

**Wrap** (off by default, render-only — hence deliberately absent from the
`restart` watch) switches rows to `whitespace-pre-wrap` and measured heights
(`measureElement`; the ref forwards `null` too, the virtualizer's unobserve
hook); toggling calls `virtualizer.measure()`, since every cached row height
becomes wrong either way. **JSON coloring** is automatic, no toggle:
`utils/logJson.ts` returns tokens or `null` (plain text, fragments, trailing
garbage), rendered as interpolated `<span>`s so log text stays escaped — still
no `v-html`. The scanner emits **original substrings**, never a `JSON.parse`
round-trip, keeping int64 ids past 2^53, `1.0` and key order as written. A
`level`/`severity`/`lvl` value (string or pino/bunyan number) is colored by
severity, and an RFC3339 prefix from `timestamps=true` is kept as its own dimmed
token so stamped lines still parse. `logTokenClass` returns the whole class in
one expression (Tailwind order gotcha), and `LogViewer` memoizes tokens per line
in a bounded per-instance cache, since visible rows are re-derived every scroll
frame.

### Overview cards

Object events render on the Overview as a table block (`EventsCard.vue`, last
card, `kubectl describe` order), only when there is at least one. Child
resources render as compact tables via the **Table API** (`listAllAsTable` walks
continue tokens; `utils/miniTable.ts` `tableToMini` keeps the server's
priority-0 columns — universal, no per-kind field hardcoding — and drops the
Name column into a link; `ResourceMiniTable.vue` renders with list-page status
coloring). `RelatedResourcesCard.vue`: owner children (narrowed by the parent's
`spec.selector` server-side, then filtered by `ownerReferences.uid`
client-side), Service→Pods, and Ingress→Backend Services as a link list (names
from the spec, objects not fetched). A Deployment also lists its Pods
(grandchildren) by collecting owned ReplicaSet uids from the first hop and
matching pods against that set, so a foreign overlapping selector is excluded.
`NodePodsCard.vue` (Node Overview) uses the `spec.nodeName` field selector
cluster-wide → needs cluster list-pods RBAC. Both cards guard stale overlapping
loads with a request-id and surface `truncated` when the bounded scan caps
out.

They — and `EventsCard` — reload on the **object's identity** (`watch(() =>
props.object)`), not on `metadata.uid`: the detail object has no watch stream
(`useResourceObject` is fetch + explicit refresh), so every Refresh / YAML apply
/ kind action hands over a new object with the same uid, and a uid key would
leave child tables and events showing pre-action state. A **failed** refresh of
the object already on screen keeps it (the error renders alongside); only a
failure for a *different* target clears it (`loadedKey` in `useResourceObject`),
because the whole tab area hangs off `object !== null` and nulling it on a
transient 500 would unmount the detail view — and with it a live exec session or
log stream.

A **Details** card (right under Metadata) renders everything outside the
`apiVersion`/`kind`/`metadata`/`spec`/`status` skeleton —
`utils/topLevelFields.ts` collects the leftover keys and empty-prunes them; the
card renders only when something survives. By shape, not by kind, so it covers
Event (`type`/`reason`/`message`/`involvedObject` — an Event page would
otherwise be metadata and nothing else), StorageClass (`provisioner`,
`parameters`, …), EndpointSlice, Endpoints, RBAC (`rules`/`roleRef`/`subjects`),
webhook configurations and CRDs alike. The one kind-keyed piece is `PANEL_OWNED`
(`<apiVersion>/<Kind>`, same convention as the action registry): Secret
`data`/`stringData` and ConfigMap `data`/`binaryData` are dropped because
`SecretDataPanel`/`ConfigMapDataPanel` already render them — for a Secret the
generic tree would also print what the panel masks.

### Field tree

Overview renders `spec`/`status` as a heuristic field tree, not JSON:
`utils/fieldTree.ts` classifies by **shape, never by kind** (scalar /
scalar-array→chips / label-map→chips / flat homogeneous array→mini-table /
object-array→titled items / object→collapsible group), so it covers CRDs too;
`ObjectFieldTree.vue` renders it (long values, big subtrees and deep levels
collapse). A per-section `compact` toggle (default on) cuts noise via
`utils/fieldFilter.ts`: `pruneEmpty` drops `null`/`""`/`{}`/`[]`, and for `spec`
`compactSpec` narrows to **user-declared** fields to hide apiserver defaults,
best signal first: (1) the `last-applied-configuration` annotation (client-side
`kubectl apply` — the common case, and the only signal that works for it, since
client-side apply round-trips the whole defaulted object through managedFields),
intersected structurally with list elements matched by merge key
(`name`/`containerPort`/…); (2) SSA ownership from `metadata.managedFields`,
**operation `Apply` only** (`Update` ownership includes round-tripped defaults);
(3) neither → plain empty-pruning (controller-owned Pods/ReplicaSets). It
reports `{filtered, source}` and falls back to the full spec if filtering
empties everything (version skew). `raw` always shows untouched JSON.
`status.conditions` is skipped when `ConditionsTable` already covers it.

The tree also links **object references**, by shape and not by kind: any nested
record carrying a `kind` **and** a `name` (`involvedObject`/`related`,
`roleRef`, `subjects`, `scaleTargetRef`, `dataSource`, CRD fields) makes
`fieldTree` stamp an `ObjectRef` on its `name` leaf (`objectRefOf`), and
`ObjectFieldTree` turns that leaf into a RouterLink. Resolution stays in the
component (the util is pure): `findByKind(apiVersion, kind)` when the ref
carries an apiVersion, otherwise — and as a fallback for a ref naming a
long-gone apiVersion — `findByLowerKind(kind, apiGroup)`. The namespace is the
ref's own, else the rendered object's (`ObjectFieldTree`'s `namespace` prop,
threaded through the recursion); a namespaced target with neither stays plain
text rather than linking to a certain 404. Resolved routes are memoized in a
computed map, since the template asks per rendered leaf on every render.

Both resolvers skip entries that `canGet` rejects (`useDiscovery`): every
caller resolves a route the detail page then GETs, so a resource declaring
verbs **without** `get` — create-only reviews like TokenReview/
SubjectAccessReview, which a `roleRef`/`subjects` block does name — would only
link to a 405/403. An **empty** verb list is treated as linkable: some
aggregated APIs report no verbs at all, and hiding those links would be worse
than a rare dead one.

### Shared UI

Icons are a **local set**, not a dependency: `utils/icons.ts` holds every glyph
as `{ view, paths, stroke? }` (`stroke` present = outline) and
`components/ui/AppIcon.vue` renders it (`<AppIcon name="…" class="h-4 w-4" />`).
An SPA embedded in the binary must not fetch glyphs at runtime (rules out
`@iconify/vue`), and ~a dozen icons is not mass enough for a build plugin. The
24x24 outline glyphs are Heroicons v2 (Tailwind Labs, MIT — attribution they
lacked while inlined); the 20x20 ones are drawn here. `AppIcon` sets **no** size
or color of its own (a default would collide, and stylesheet order — not class
order — would win) and is always `aria-hidden`, so every icon-only control
carries its own `title`/`aria-label` (Reload/Download in `PodLogsTab`,
`RevealButton`, `ThemeToggle`). `GaugeCard`'s SVG is a chart, not an icon, and
stays inline.

Every `<select>` in the app is `components/ui/BaseSelect.vue` (generic over the
model type — callers bind strings, numbers and `"all" | number`): a native
select with `appearance-none` and the same `caret-down` the hand-built pickers
draw, since the browser's own arrow is a different glyph in every engine and
`ContainerSelect` sits next to `EditableCombobox`, `NamespaceSelector` next to
`ClusterSelector`. They stay native — only the arrow is ours — because a
`<select>` costs nothing in popup, keyboard and a11y behaviour; `ContextListbox`
is custom only because it needs a panel taller than a native popup allows.
`inheritAttrs: false` puts the caller's attributes on the inner `<select>`, not
the positioning wrapper: `NamespaceSelector`'s `<label for="ns-select">` points
at it. Do not reintroduce a bare `<select>`, and do not put `.number` on its
`v-model` — options bind real numbers already, and the modifier would only
coerce a string form that never occurs.

Shared value UX in `components/ui/`: `RevealButton.vue` (eye toggle) and
`ExpandableValue.vue` (truncate/expand), used by SecretDataPanel,
ConfigMapDataPanel and PodEnvTab; base64 decode is `utils/base64.ts`.

### Auth abstraction

The resource layer only sees `CredentialProvider` (`web/src/auth/`, including
`getContext()`) — OIDC later means swapping `KubernetesTokenProvider`, with no
resource-layer changes. `api/http.ts` owns 401→logout and 400→unknown-context
via injected handlers (no router import cycles). Both handlers — and
`logout(context)` — are **told which context the request was routed to**,
captured before the `await` (`X-Kube-Context` as actually sent, `""` for the
default). A response can land long after the user switched clusters, so nothing
here may key off "the active context" at failure time: a late 401 from cluster A
used to end cluster B's session. `main.ts` therefore ends only the request's own
session and performs the *global* part — the login redirect, the reset to the
default context — only while that context is still active.

### Charts and metrics

`MetricsChart.vue` overrides two uPlot axis defaults. The Y axis sizes itself
from the measured width of the current tick labels (canvas `measureText` with
uPlot's default axis font mirrored as a constant; falls back to a per-character
estimate without a 2d context, i.e. jsdom) — a fixed width clipped labels once
the cluster grew into "1234.00 cores". The X axis takes labels from
`utils/timeAxis.ts`, because uPlot's built-in stamps are hardcoded US
(`7:51pm`, `7/21/26`) and ignore the browser locale; `timeAxisLabels` formats
with `Intl` (seconds only below a minute per tick, date as a second `"\n"` line
on the first tick and each day rollover).

The backend adapter normalizes Quantities (nanocores/bytes) and passes
capability states (`available|not-installed|forbidden|unavailable|disabled`).
The `metrics.k8s.io` version always comes from discovery, never hardcoded, and
it is the one upstream-supplied string that ends up **in a path**
(`/apis/metrics.k8s.io/<version>/…`), so `versionRe` (`^v[0-9]+((alpha|beta)[0-9]+)?$`,
`capabilities.go`) is what may enter it — the same reason namespace/name are
`nameRe`-checked in `handler.go`. An advertised `preferredVersion` failing that
check falls through to the first *usable* entry in `group.Versions` rather than
failing the probe, so one unusable entry cannot hide a valid version behind it.
The frontend polls ≥15s only while the tab is visible, into in-memory ring
buffers (240 samples, deduped by source timestamp). The buffers live in a shared
cache (`utils/metricsCache.ts`) keyed per axis by context-prefixed scope
(`<ctx>:pod:<uid>:cpu`, `<ctx>:node:<name>:cpu`, `<ctx>:ns:<namespace>:cpu`,
`:mem`), so history survives screen/tab switches and a late response from the
previous cluster never lands in the new cluster's buffer (node/namespace names
collide across clusters, hence the prefix). The three chart owners
(`PodMetricsTab`, `NodeMetricsTab`, `NamespaceOverviewPage`) rebind their
`shallowRef` to the cached buffer on scope **or** context change rather than
clearing it (a per-scope key also stops node→node series from blending). The
cache is memory-only (a refresh clears it), bounded (TTL 1h — the widest chart
range — plus a 64-scope cap evicting the scope with the oldest newest-sample, so
an actively updating chart never goes before a stale one) and adds **no** new
browser storage. Ending a session wipes its series so a re-login never shows the
previous session's charts: Sign out, the 401 handler and TTL expiry all reach
`evictContextCaches(context)` and evict only the ended context's `<ctx>:` scopes
(`clearMetricsCacheContext`); the vue-query cache is pruned in the same call
(scoped `removeQueries`, never `queryClient.clear()`).

### Overview page

`NamespaceOverviewPage.vue` tops its namespace pod charts with a cluster summary
row of donut gauges (`ClusterSummaryCards.vue` → `GaugeCard.vue`, pure-SVG
rings, no chart lib). The halves are labelled and separated by a rule because
only the lower one follows the namespace selector: the gauge row carries its own
"Cluster · global view" heading (**inside** its availability guard, so a
forbidden node list hides the title too), the block below names the selected
namespace ("All namespaces" when none). `useClusterSummary.ts` fills the gauges
on the metrics cadence from three cheap calls — `GET /k8s/api/v1/nodes`
(allocatable cpu/memory/pods via `parseQuantity` in `utils/units.ts`, plus Ready
conditions), `fetchAllNodeMetrics` (usage; null when metrics are absent, gauge
shows "—") and a one-page `fetchPodCount` (`includeObject=None` Table +
`remainingItemCount`). A forbidden node list (namespace-scoped tokens) hides the
whole row; the Pods and Nodes gauges link to their lists.

## Testing conventions

- Go: fake upstreams via `httptest` + hand-built `kube.Upstream`; exec tests
  dial a real WebSocket against `httptest` with an injected `ExecutorFactory`
  fake. Leak tests assert sentinel tokens never appear in logs/errors.
- Frontend: vitest + jsdom. `web/src/test/setup.ts` polyfills localStorage/
  sessionStorage (Node ≥22 shadows jsdom's), ResizeObserver (needed by
  @tanstack/vue-virtual) and matchMedia (uPlot calls it at import time, so any
  test whose import graph reaches a chart needs it); component tests stub
  `getBoundingClientRect` so the virtualizer renders rows.

## Gotchas

- Tailwind: never put a static text-color utility on an element that also gets a
  conditional one — stylesheet order decides the winner, not class order (this
  once made red `Failed` statuses render neutral). Pick the full class in one
  expression.
- `vite build` empties `web/dist`; `web/dist/.gitkeep` must exist for
  backend-only builds (the Makefile re-touches it).
- Status color-coding applies only to status-bearing columns (`isStatusColumn`),
  otherwise names like "error-page" light up red.
- The gateway blocklist makes objects literally named
  `exec`/`attach`/`portforward`/`proxy` unreachable — known limitation,
  documented in README.
- CodeMirror (`CodeMirrorEditor.vue`, ~110 kB gz) is imported via
  `defineAsyncComponent` in YamlTab/EditYamlDialog/CreateResourceDialog so it
  loads only when the YAML tab or an edit/create dialog opens — never on the
  default Overview detail view. Keep it lazy (no static import) and keep the
  hand-picked extension set instead of `basicSetup` (which pulls autocomplete/
  lint/search we don't use). Code folding IS kept — cheap (rides on the
  already-bundled `@codemirror/language`) and useful on large manifests.
