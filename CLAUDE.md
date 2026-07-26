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

`NewUpstream` therefore writes the parsed base **back** onto `RestConfig.Host`,
so `Host` and `BaseURL` cannot disagree. exec is the one path that builds its URL
from `Host` rather than `BaseURL`, and letting the two drift cost more than
tidiness: a scheme-less host (`--api-server apiserver:6443`, or the same in a
kubeconfig `server:` — neither requires a scheme) left `Host` scheme-less, and
with no `--ca-file` client-go's `DefaultServerUrlFor` computes `defaultTLS =
hasCA || hasCert || Insecure` = false and falls back to **`http://`**, which its
websocket round tripper maps to `ws://` and then attaches the user's bearer to.
So exec sent the token in cleartext while the gateway, `kube.Do` and `/readyz`
all used TLS and startup logged the https form — invisible to the operator.
Normalizing once also drops userinfo from `Host`, which `stripHostCredentials`
only did when userinfo was present in the first place.

**The one carve-out: `--use-kubeconfig-credentials`** (`Config.
UseKubeconfigCredentials`). The invariant above stays the default and every
deployed configuration; this flag is opt-in local development, where the
alternative is pasting a bearer token per cluster that the same kubeconfig
already holds. With it, `RESTConfigs` swaps `anonymize` for
`keepUserCredentials` on the **kubeconfig branch only** — which does nothing but
`stripHostCredentials`, so URL userinfo is dropped even here (client-go would
turn it into `Authorization: Basic`, which its own bearer round tripper then
refuses to overwrite, sending the operator's credentials instead of the
context's; and that URL is what startup prints). Token/`tokenFile`/client-cert/
`ExecProvider` kubeconfigs all ride along for free: `rest.TransportFor` already
handles them. The fences are `config.validate` **startup errors**, not warnings:

- kubeconfig only — `--api-server` is rejected, and so is running in a pod,
  checked as `KUBERNETES_SERVICE_HOST` **directly** rather than via the derived
  `KubeAPIServer`: `applyInClusterDefaults` returns early when a kubeconfig is
  set, so an in-cluster pod with one mounted would otherwise sail through, and
  a pod's loopback is shared with every container in it;
- `isLoopbackListen(ListenAddr)` — `127.0.0.1`/`[::1]`/`localhost`, since
  reaching the listener *is* holding the kubeconfig, like `kubectl proxy`;
- `RequireLoopbackHost` (`server/middleware.go`), mounted only in this mode:
  the listen address stops other machines, not the developer's own browser, and
  a page rebound to 127.0.0.1 by DNS arrives with `Host`/`Origin` both set to
  its own name — same-origin, so CORS never applies and coder/websocket's
  origin check (Origin vs Host) passes. This is `kubectl proxy`'s
  `--accept-hosts`, and without it the whole mode is one visited site away from
  handing over the cluster;
- a startup `WARN` in `server.Run`, and the Helm chart never exposes the flag.

Mechanically: `Upstream.UseConfigCredentials` + `Upstream.RoundTripper(token)`
is the chokepoint (`kube.Do` calls it instead of `WithBearer`; the readiness
probe is the one deliberate exception, having no user to speak for), and
`Registry.RequireToken` — which replaced the token gate copied into six
handlers — returns `("", true)` in this mode instead of a 401, so callers pass
`""` down. The flag is stamped onto each upstream from `NamedConfig.
UseCredentials` — what `RESTConfigs` actually *did* — never re-read from
`cfg`: only the kubeconfig branch keeps credentials, and an anonymized upstream
marked credentialed would authenticate with nothing at all. `Registry.
useConfigCreds` is likewise derived from the default upstream, in both
constructors. That registry value is the **single** source of truth every
decision site reads, `RequireLoopbackHost` included (it was once mounted off
`cfg.UseKubeconfigCredentials || registry.UsesConfigCredentials()`, which left
one fact readable from two places); the flag is only what was asked for, and
`server.Run` **refuses to start** when the two disagree rather than letting half
a mode be served — `config.validate` has already rejected every combination in
which the request could fail to reach the registry, so a disagreement means the
precedence in `RESTConfigs` moved under it. Two consequences worth keeping in
mind: the gateway **deletes the
inbound `Authorization` header** in `rewriteFor` (client-go will not overwrite
one, so a client-supplied token would otherwise pick the identity the apiserver
sees) — keyed off the **upstream** the proxy dispatches to, not a process-wide
copy, so a mixed registry cannot leave the strip off for a credentialed context
— and `exec`'s auth frame requires the token to be **empty**
(`validate(requireToken)` rejects a non-empty one, mirroring that Del rather
than relying on `session.go` merely ignoring it) while `session.go` leaves
`cfg.BearerToken` alone rather than blanking the kubeconfig's own.
`GET /api/ui/auth/mode` (unauthenticated, `adapters.go`) is how
the SPA learns which mode it is in before the route guard runs; in token mode it
is a constant, and in kubeconfig mode the listener is loopback-only anyway.

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
- The idle deadline is one of several paths that can end a session, so they
  claim the teardown through a shared `ending` flag (`idleFired`'s
  compare-and-swap): `time.Timer.Stop()` cannot recall a callback that has
  already started, and the session context is no substitute for the flag —
  `cancel()` is deferred *before* `idle.Stop()` and therefore runs *after* it,
  so a deadline landing anywhere in the normal teardown would see a live context
  and chase the exit frame with an "idle timeout" error frame. The ordinary path
  claims it the moment `awaitStream` returns.
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
  reads the socket; the blocking stdin-pipe write lives in `stdinPump`.
  `readLoop` must **never block anywhere but `conn.Read`**, and a bounded channel
  was not enough: with the queue full its send parked the reader just as the pipe
  write once did, coder/websocket's `Ping` needs a concurrent `Reader` to see its
  pong, and a healthy session was killed 40s later (one 30s tick plus the 10s
  pong deadline — measured). So the handoff is `stdinQueue`, a **byte**-bounded
  staging buffer (`Handler.stdinBufferLimit`) whose `push` refuses instead of
  blocking; exceeding it ends the session with the reason stated, never a silent
  drop, which would corrupt the byte stream the command eventually reads. Each
  frame is charged an overhead allowance on top of its payload, since interactive
  input is one tiny frame per keystroke. `pingInterval`/`pingTimeout` are
  `Handler` fields for the same reason `drainTimeout` is: the regression test has
  to cross several keepalive cycles, and the case no earlier test covered is
  **more** frames than the queue holds (the predecessor sent one, which parks
  `stdinPump` and leaves `readLoop` in `conn.Read`).
- The `websocket.Accept` failure is logged **without** `err`: coder/websocket
  builds those messages out of inbound header values (Origin, Host, Connection,
  Upgrade, Sec-WebSocket-Version, Sec-WebSocket-Key), and this endpoint is
  pre-auth and rate-limited only if the operator opted in, so the error text is
  client-controlled log volume. The client address is logged instead.

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
  limiter key per request. Off-proxy peers key by RemoteAddr — and that is the
  *only* thing the `RemoteAddr` fallback in `ClientIP` does **not** cover, which
  its comment used to claim it did: `ClientIPFromRemoteAddr` always stores the
  peer, so with the resolver mounted the fallback is reached only by a request
  *from* a trusted proxy whose XFF named no usable client (absent — a proxy
  forwarding only `X-Real-IP` — unparsable, or entirely trusted hops), and it
  then keys everyone behind that proxy on one shared bucket. Fail-closed, but the
  opposite of what naming the CIDRs was for. Two assumptions therefore ride on
  `--trusted-proxies`, both now documented in README/values.yaml: the CIDRs
  contain **proxies only** (chi walks XFF right to left and skips trusted
  entries, so a range covering your own pods makes the walk adopt the
  client-written entry to the left — a fresh bucket per request), and those
  proxies **append** a per-client entry.
- `internal/server/limits.go` spends the resolved IP on one shared `httprate`
  budget (`--rate-limit`, per client per minute) alongside the
  address-independent concurrency cap (`--max-in-flight`). Both are mounted on
  `/k8s/*` **and** `/api/ui/*` — one limiter instance each, so the prefixes
  cannot be alternated to spend a budget twice — and outermost, ahead of body
  limits and dispatch, so a shed request costs only the check.
- The **body read deadline** (`bodyReadTimeout`) is mounted on the **root**
  router beside `WriteDeadline`, while the size cap (`maxBody`) stays
  gateway-scoped. They were one gateway-only wrapper, which left every other
  route with no bound on how slowly a body may arrive: `http.Server` sets
  `ReadHeaderTimeout` and `IdleTimeout` but deliberately no `ReadTimeout`, and
  net/http clears the header deadline once headers are read, so the post-handler
  drain reads from the client unbounded — measured holding a connection open for
  hours at a few bytes per second, unauthenticated, on `POST
  /api/ui/auth/verify`'s own 401 path, the `/api` 404 and the SPA fallback
  alike. It keeps the `methodHasBody` guard, so GET watch/log streams arm
  nothing. The size cap can stay narrow because the one body-bearing
  `/api/ui/*` route never reads its body.
- `--max-in-flight` and `--max-exec-sessions` are bounded **above** in
  `config.validate` as well as below: both are multiplied by a pool factor into
  a `make(chan)`, so an absurd value overflowed `int` and either panicked at
  startup (`makechan: size out of range`, an uncaught stack trace instead of the
  clean config error every other bad value gets) or — worse, at `2^61`/`2^62` —
  wrapped to exactly **0**, silently shedding every streaming request with a 429.
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
- An adapter that stops reading an upstream response early — a non-2xx, a decode
  failure, a probe that only wants the status — must drain before `Close` or
  net/http cannot pool the connection, and that drain is **bounded** in exactly
  one place: `httpx.DrainAndClose` (64 KiB, `internal/httpx/drain.go`), used by
  `CopyUpstreamError`, `auth.VerifyToken`, discovery's `getJSON`, both metrics
  paths and the readiness probe. Unbounded, the size of that courtesy was the
  upstream's choice and was paid while holding an in-flight slot. The bound is far
  above any `Status` or `APIGroup` body, so ordinary responses are still drained
  whole and still pool; a bigger one loses its connection instead of our time,
  which is the right way round — keep-alive is an optimization. Do not add a
  second drain policy or a per-caller limit.
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
Three things keep that promise honest. The aggregated attempt and the legacy
fallback get **half the budget each** rather than sharing one deadline: the
aggregated path can spend four upstream calls (two Accept variants × `/apis` +
`/api`), and burning the whole budget handed legacy a dead context — a 502 where
legacy would have answered. Which is also why `fetchAggregated` runs its two
roots **concurrently** (an `errgroup`, like `fetchLegacy`) instead of back to
back: halving the budget halved the time those serial round trips had, raising
the odds of exactly the timeout the split exists to prevent. The result is still
assembled `/apis` first, then `/api`, so the catalog order does not depend on
which reply arrives first. When legacy then fails with an error carrying no
status, the **aggregated** status is preferred, so a 401/403 is not masked by a
fallback that died on the network. And `fetchLegacy` **errors when every**
group-version failed (`len(groupVersions) > 0 && failed == len(...)`, surfacing a
status-bearing error when one was seen, else `ctx.Err()`): per-group skipping is
deliberate, so one broken aggregated API cannot break the sidebar, but returning
`(nil, nil)` answered `200` with an empty catalog, and the SPA cannot tell that
from an empty cluster — `useDiscovery` coerces with `?? []` and `Sidebar.vue`
renders its error line only on `isError`, so a total failure painted a blank
sidebar with no message. **`fetchAggregated` errors on an empty catalog for the
same reason**, and it has to be said separately: it is tried first and wins
whenever it does not error, so two roots answering `200` with nothing to name
(an aggregation layer or admission proxy in front of the apiserver) reached that
blank sidebar without legacy ever being asked. `Response.Resources` also
serializes as `[]`, never `null`, the normalization `nonNilVerbs` already
applies one level down. Both aggregated requests go through
`fetchAggregatedOnce`, which checks the **status before reading the body** and
drains through `httpx.DrainAndClose` like every other adapter — it used to
buffer up to 32 MiB of a 403 or a 500 only to discard it, twice per root,
concurrently, while holding an in-flight slot. Its `fatal` return is what keeps
the second Accept variant meaningful: only a failed round trip skips it, while a
status, an unparsable body or a plain `APIGroupList` are exactly what the retry
is for.

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
script — until a reload. `isAuthenticated` checks the TTL too — a token alone is
not authentication, or switching to a stale context flashes past the login guard
as authorized — and it does so by **being** that predicate for the active
context: `computed(() => hasSession(activeContext.value))`, one rule rather than
two copies of it, so the route guard and the switcher's "signed in" mark cannot
drift apart. (`parseSession` still spells the expiry rule out a third time, and
has already drifted: `expiresAt: 0` reads as "never expires" there while the
restore path drops it. Left alone deliberately — it is a parser, not a gate.)
A restore that drops expired/tampered entries rewrites
sessionStorage immediately; tests assert all of this with sentinel tokens.

In the `--use-kubeconfig-credentials` mode none of this runs: `stores/auth.ts`
holds a plain `localAuth` flag (set once in `main.ts` from `fetchAuthMode()`; a
fetch failure falls back to token mode, i.e. onto the login page). The **route
guard awaits that probe** — `createAppRouter(authModeReady)`, `await
authModeReady` as the guard's first line — and awaiting it before `app.mount`
is *not* a substitute, which is what the code used to do: installing the router
starts the first navigation, so the guard ran with `localAuth` still false, and
in this mode there is no session for `isAuthenticated` to fall back on. It
therefore redirected to a login page this mode says does not exist, with no
later navigation to correct it — a login form on every page load, from which
picking any context walked straight back into the app. Because an
immediately-resolved probe can win the race, the bug was intermittent, so its
regression test answers the probe a macrotask late.
`isAuthenticated`/`hasSession` then answer true for every context and `token`
reads `null` — **explicitly** so, not merely because no session exists: a record
left over from a previous run in token mode would otherwise attach a stale
bearer to every request that nothing in this mode can clear (Sign out is hidden,
the 401 handler and `logout` are no-ops). No credential reaches sessionStorage;
a cluster switch still persists the selected context *name* through the shared
`setActiveContext`, which is a name, not a token. `identity` resolves from
`localIdentity`, filled by
`useLocalIdentity` (a `["identity", ctx]` query called in `App.vue`, so `TopBar`
keeps reading `auth.identity` and needs no vue-query of its own); `TopBar` hides
Sign out; `KubernetesTokenProvider.logout` is a no-op; `main.ts`'s 401 handler
returns early — a 401 there means the apiserver rejected the *backend's*
credentials, and `/login` would be a loop in front of a form with nothing to
fill in.

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
(`static.go`, rooted first — `Clean` only resolves `..` against a leading `/`):
chi does not normalize, so `//api/ui/discovery` and `/api/../api/ui/discovery`
reached the fallback as non-API paths and answered `index.html` with a 200. The
**request** is rewritten onto that cleaned path too (`withPath`), because
`http.ServeFileFS` rejects any URL still holding a dot-segment with its own
plain-text 400 whatever filename it is handed — so `/r/core/v1/../pods`, a
client-side route, got that instead of the SPA.

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

### Page title and cluster label

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

The same name is on screen as well, in `layout/ClusterName.vue` between the
sidebar's product name and the switcher — a tab title is precisely what is not
readable while looking at the page. It renders **only** the configured name
(trimmed, absent when empty), never a fallback to the active context: that is
what the switcher below shows, and with one synthesized `default` context the
switcher is hidden — the in-cluster case this label is for. Its own component
rather than lines in `Sidebar.vue`, like `ClusterSelector`, because it reads the
contexts query and `Sidebar.spec` must not stand up vue-query (both are stubbed
there).

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
regardless of source — except under `--use-kubeconfig-credentials`, which
substitutes `keepUserCredentials` on the kubeconfig branch (see the carve-out
above). The Helm chart needs no
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
method/path only, once per response) because the ReverseProxy's abort path is
otherwise quiet: it panics with `http.ErrAbortHandler`, which `Recoverer`
deliberately re-panics. `RequestLogger` logs from a **defer** so its line
survives that unwind — undeferred, every aborted stream (a closed tab on a watch
or log follow) left no trace in the request log at all, and `reportTimeout` is
no substitute since it fires only on `os.ErrDeadlineExceeded` and an ordinary
disconnect is `EPIPE`/`ECONNRESET`. Both wrappers also implement
`FlushError() error`, not just `Flush()`: `http.ResponseController` matches
`FlushError` **first** and only then walks `Unwrap`, so a bare `Flush` swallowed
the very deadline error this middleware exists to raise.

Shutdown (`server.Run`, SIGINT/SIGTERM) grants a fixed 15s `srv.Shutdown()`
before an unconditional `srv.Close()`, but streams need not ride it out:
`Deps.ShutdownCtx` is threaded through `AbortOnShutdown` (same file), which
wraps the `/k8s/*` gateway handler (matched via `gateway.IsStreaming`) and
unconditionally wraps `/api/ui/exec/ws`. It cancels those contexts the instant
shutdown starts, **with cause `httpx.ErrShutdown`** — the sentinel is what lets
the ReverseProxy's `errorHandler` tell the two cancels apart, since a departed
client and a shutdown abort are the same `context.Canceled` there: staying
silent for the latter let net/http complete the response as an empty **200**,
which a watch client reads as a clean end of stream, so a still-connected client
now gets a 503 while a gone one is still answered with nothing. `srv.Shutdown()`
then only waits for ordinary short requests.

`IsStreaming` must agree with the apiserver about what streams, because a stream
misread as unary pins a slot in the small unary pool for its whole lifetime and
rides out the entire grace period. Two shapes were missed and are now covered:
booleans go through `apiBoolValue`, an exact mirror of apimachinery's
`Convert_Slice_string_To_bool` (absent → false; **present → true unless `0`/
`false`**, so `?watch=yes|2|` all stream), because `strconv.ParseBool` rejects
every one of those while the apiserver accepts them; and `isLegacyWatchPath`
matches the deprecated watch prefix the apiserver still registers with watch
forced on, keyed to the **segment position** (`/api/<v>/watch/…`,
`/apis/<g>/<v>/watch/…`) so an object literally named `watch` deeper in the path
does not match.

Because it now parses the query *and* walks the path segments, and **two**
middlewares on `/k8s/*` ask it the same question about the same request, the
verdict is resolved once per request and shared: `streamClassifier`
(`server/limits.go`) is mounted inside the rate limit — a shed request never pays
for the classification — and outside both consumers, since only a value set ahead
of them is on the context they read (wrapping is inside-out; `AbortOnShutdown`'s
derived context inherits it). `verdict` **falls back to evaluating the
predicate** when no value is present, and that fallback is load-bearing rather
than defensive: the `/api` subrouter mounts the cap with its own `isExecWS`
predicate and no classifier, and without the fallback a consumer with nothing in
front of it would classify by the zero value — pinning every watch in the small
unary pool, or, had the default gone the other way, handing out the loose stream
pool to everyone, which is the opt-out the cap must never have. The value is
per-request only; a cross-request cache keyed by path or query would be a second
source of truth for what streams.

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
in `NamespaceSelector` when the new **complete** list loads — a truncated list
with a continue token cannot prove absence and never resets). That list comes
from `fetchNamespaces` (`api/k8s.ts`), a bounded continue walk (6×500, like
`walkTable`) through `resourcePath` rather than a hardcoded `/k8s` URL, and it
returns the final continue token so "complete" stays knowable. The select also
renders an option for the **selected** namespace whenever it is missing from the
loaded names, plus a disabled marker for a truncated list: a `v-model` value no
`<option>` matches leaves the control blank while every list on screen is still
filtered by it, and the value could not even be picked again.
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
rebinds the form and clears the previous rejection message.

A context removed upstream is noticed two ways — a backend `400` "unknown
cluster context" on any request (`api/http.ts`) and the reconcile watch seeing
it leave the list — and both go through **one** function,
`recoverFromUnknownContext` (`useContexts.ts`), because they are one decision
and drifted while they were two copies. It (1) ends that context's session via
`clearSession`, the same single end-of-session path, since every request would
carry the name the backend rejects, so nothing can spend the token and leaving
it would keep the login page offering a dead cluster badged "signed in"; (2)
falls back to the default's **name**, and to the *current* name when no list is
known — never `""`, which resolves to no session and orphans every still-valid
one, and the no-list case is the common one rather than a corner: fetching
`["contexts"]` carries the rejected name too, so after a reload it has already
failed exactly as the request did; (3) routes to `/login` when the fallback has
no session, instead of leaving a protected view firing tokenless requests until
one 401s; (4) **collapses a `resource-detail` route to its list** when the
fallback *is* authorized and nothing else redirects, exactly as
`ClusterSelector.switchContext` does on a deliberate switch — `ResourceDetailPage`
is the one page with no context reactivity (`useResourceObject` refetches on a
route-param change only), so the header, YAML tab and action buttons would keep
describing the vanished cluster's object while Delete and Apply already carry
`X-Kube-Context: <fallback>` and hit the same-named object in another cluster;
and (5) reports whether the caller should refetch the list — **not**
when the fallback is the rejected name itself, since re-issuing the request that
just failed re-enters the handler, which was a request loop with no backoff.

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

`buildUrl` reconnects with the namespace and label selector the rows on screen
were **actually listed under** (pinned in `load()`), never the live options: the
toolbar binds `labelSelector` with a plain `v-model` and only applies it on
Enter, so between a keystroke and Enter the live value and `resourceVersion`
describe different collections — and the apiserver closes watches routinely, so
the reconnect resumed the unfiltered collection's `resourceVersion` under a
half-typed selector. Every row outside it then silently stopped updating and its
DELETED events never arrived, with `watchDegraded` still `false`. The context
watch also `stop()`s the stream **before** its `isAuthenticated` gate, like the
sibling watches in `useClusterSummary` and `ProblemPodsCard`: `refresh()` is what
would otherwise have stopped it, so a switch to a context with no session left
the previous cluster's stream upserting rows into a list now labelled as the new
one.

Because a whole collection sits behind a live watch, everything on the per-event
path is sized against the 5000-row cap, not against the one row an event usually
carries. The `rowKey → index` map is therefore kept **across** events (it was
rebuilt per event, so absorbing one MODIFIED ran `rowKey()` over all 5000 rows,
dozens of times a second during a rollout), with `setRows()` as the single choke
point for every wholesale assignment — that is what keeps map and array in step
and what stops the map surviving a resource-type/namespace/context switch. Only
the upsert path updates it incrementally; a DELETE shifts every surviving
position, so it rebuilds through the same choke point, which is affordable
because deletes are rare next to modifications. The array identity **must still
change** on every update — `ResourceTable` memoizes cell views per TanStack Row
and TanStack rebuilds those exactly when `data` changes identity — so the copy
stays; it is a pointer memcpy, and the `rowKey()` calls were the cost. In
all-namespaces mode `withNamespaceCells` then re-projected the same 5000 rows per
event (a row object and a cells array each) to absorb one change, so the
projection is memoized per source row in a `WeakMap` (`utils/namespaceColumn.ts`)
— module-level and shared, which is safe because it is a pure function of the row.
That memo saves the allocations only: the projected rows' identity does *not* help
`ResourceTable`'s memo, which dies with the array identity above.

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
render — and `ResourceTable` memoizes, in a `WeakMap` keyed by the **TanStack
Row**, everything the template needs per cell: the route, the displayed text and
the resolved color class (`CellView`). The Row is rebuilt exactly when `data`
changes (sorting and filtering reuse the instances, so a cached row is one whose
cells and values are unchanged — which is what makes the cached text and class
safe to hold). What row identity does not cover is invalidated
by hand: the column set, which decides which cells are visible, and `cellLink`
itself. Without the memo every scroll frame allocated an array per rendered row
and a wrapper per cell for a route that is `null` on every list but events —
and, per cell, re-derived the status class: a regex test, plus on status columns
a `split(",")` and a handful of substring scans per part, ~240 times a frame.
Whether a column carries statuses depends on the column alone, so `isStatusColumn`
is resolved into a `statusColumnIds` set per column set, never per cell. The
neutral fallback is baked **into** that one class string, per the Tailwind order
rule below — a static color utility beside a conditional one lets stylesheet
order pick the winner — and it is `NEUTRAL_TEXT_CLASS` from `statusColors.ts`,
not a literal, because `ResourceMiniTable` and `ObjectFieldTree` complete the
same nullable `statusTextClass` answer and three copies of the string is how a
repaint leaves some views behind. The plain (unlinked) cell renders `{{ text }}`
straight from the memo rather than through `FlexRender`: `accessorFn` is
`cellText`, so the column def's `cell` renderer only ever produced that same
string, at the cost of one component instance per cell per frame.

`ResourceTable` takes the identity of what is listed as an explicit **`resetKey`**
prop (`ResourceListPage` passes `<group>/<version>/<resource>`), and that — not
the joined column names — is what may reset manual widths, the chosen sort and
the empty-column memo. Names fail in both directions. They go *blank* mid-reload,
because `useResourceList.load()` clears `columns` before every walk so the
previous kind's rows cannot linger, so keying on them threw the user's sort and
drag-resized widths away on every Refresh, every label-selector apply and every
410 relist — the last with no user action at all. And two kinds whose printers
emit the same names (`Name|Age`, ordinary for CRDs) are indistinguishable, so
navigating between them reset nothing. The width memo stays keyed on the column
names: it is about measured content, not about identity.

That invalidation is keyed on `columnDefs`, so the defs must be **content-keyed**
and keep their previous array when nothing a def is built from changed. Their
computed reaches `props.rows` (via `emptyColumnNames` and `defaultWidths`), so it
re-ran on every watch event: the memo was dropped per event rather than per
column-set change, and — since the defs are also what `useVueTable`'s `columns`
getter returns — TanStack rebuilt every Column and the derived row model once per
event on a table capped at 5000 rows.

Cell text is one shared pair in `utils/tableCells.ts`, not a copy per util:
`cellText` (objects → JSON, since a blank cell reads as "the server sent
nothing") for everything that renders, and `scalarCellText` (objects → `""`) for
`podHealth`, which must **abstain** on a cell it cannot classify rather than
fall through to "error". The two used to be three near-identical private
helpers that disagreed by accident.

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
pick — **after `nextTick`**, since Vue patches `:value` by assigning `el.value`
and that setter drops a focused input's caret at the end, overriding a caret set
synchronously): the auto shell is a `sh -c` one-liner that otherwise fills the
toolbar,
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

That gated-off state gets its **own** branch (`signedOut`, ahead of the
unresolved one), because it is not a slow fetch but a dead end: a session ends
under an open tab with no navigation — TTL expiry is the usual way and the route
guard only runs on a route change — after which `enabled` is false, so no
request is made, so no 401 arrives to run the global handler's redirect to
`/login`. `resolved` then stays false forever and the tab sat on "Loading..."
until someone navigated away by hand. It covers the Pod that references no
ConfigMap/Secret at all, too: its fetches would resolve instantly, but a
disabled query does not run.

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
load arrives as hundreds of chunks and each merge re-renders. The window bounds
how *often* a merge happens, not what it costs, so the merge itself appends **in
place**: `lines.value.concat(pending)` copied the whole buffer per flush, which
with `Tail: All` and `MAX_LINES` is quadratic in the lines loaded (~100 copies of
a ~100k-line array on one bulk load), and `trim` added a second full copy once
the cap was reached — it now `splice`s the head off in place. Appending is
one-at-a-time rather than `push(...pending)`: a spread passes every staged line
as an argument, and `pending` holds up to `MAX_LINES` of them.

Neither half of a mutated `shallowRef` signals anything — mutating the array is
invisible to it, and re-assigning the same array is a no-op (`Object.is`) — so
the reactive signal is an explicit `linesVersion` counter, bumped on every
mutation, which `LogViewer` takes as a prop and reads **everything** through
(`buffer`, one computed pairing array and version). Consumers must depend on that
counter rather than on identity or `lines.length`: the length stops changing once
the buffer sits at the cap, which is exactly when Follow must keep working — the
old identity watcher was there for that same reason. `version` alone is not
enough either, because a restart hands over a fresh array; `start()` therefore
resets through a helper that empties the buffer *and* bumps the counter, or the
previous pod's lines stay on screen until the next flush. The staging array is
capped like the visible one (a hidden tab keeps streaming while its timers are
throttled), and a finished stream flushes synchronously so `running=false` never
leaves lines staged.

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
severity. `\r` counts as whitespace, which is not pedantry: the stream splits on
`"\n"` alone, so a CRLF-writing container (a Windows image, some .NET/Java
logging configs) leaves a trailing `\r` on **every** line, and treating it as
trailing garbage silently dropped coloring — severity included — for the whole
log with nothing saying why. An RFC3339 prefix from `timestamps=true` is kept as
its own dimmed
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
collapse). Mini-table cells are read with **`Object.hasOwn`**, like `podEnv.ts`
and `fieldFilter.ts`: the homogeneity check validates own keys only, so an item
naming `constructor`/`toString`/`__proto__` (`JSON.parse` makes the last an own
key) made a bare `item[col]` print an `Object.prototype` member into the cell of
every *other* row. `ObjectFieldTree`'s own collapse map is the same hazard one
level up and is fixed the other way: `toggled` is `Object.create(null)` and
`isOpen` stays a **plain indexed read**, deliberately *not* `Object.hasOwn` —
that goes through `[[GetOwnProperty]]`, which Vue's reactive proxy does not trap
for tracking, so a miss would register no dependency and the first click on a
collapsed node would never re-render. The null prototype is what makes the plain
read safe (an absent key can only be `undefined`); on a plain object a field
named `constructor` resolved to a truthy function and rendered permanently
expanded, and `toggled["__proto__"] = false` hit the prototype setter and was
discarded, so that caret never worked at all.
A per-section `compact` toggle (default on) cuts noise via
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
at it. That is also why **both** boxes carry `min-w-0` in the component itself:
the wrapper is the flex item, and with the default `min-width: auto` it keeps
the select's intrinsic width, spills out of whatever squeezed it and — the caret
being positioned against the wrapper — draws the caret over the next control
(this is what put the theme toggle "under" the namespace combobox in a narrow
header). A caller cannot fix that from outside, since its class reaches the
select. Do not reintroduce a bare `<select>`, and do not put `.number` on its
`v-model` — options bind real numbers already, and the modifier would only
coerce a string form that never occurs.

`NamespaceSelector`'s 403 fallback — a free-text input, for a token that cannot
list namespaces — binds `v-model.lazy`, and that modifier is load-bearing rather
than cosmetic: `ui.namespace` is watched by the list page (a bounded full
collection walk), the recent-events card (a 1000-item fetch) and the Overview's
metrics loop, so a plain `v-model` fired all three per keystroke and requested
`k`, `ku`, `kub`, … against the apiserver. The `BaseSelect` branch never had the
problem: a `<select>` emits once per pick.

Shared value UX in `components/ui/`: `RevealButton.vue` (eye toggle) and
`ExpandableValue.vue` (truncate/expand), used by SecretDataPanel,
ConfigMapDataPanel and PodEnvTab; base64 decode is `utils/base64.ts`.

### Sidebar collapse

The sidebar hides **entirely** — an icon rail is meaningless here, since the
entries are text Kinds with no glyphs of their own. Visibility is deliberately
**two** pieces of state, and
`sidebarOpen = narrow ? drawerOpen : !prefs.sidebarCollapsed` (`stores/ui.ts`):
`prefs.sidebarCollapsed` (localStorage, through the allowlist serializer) is the
choice made on a **wide** viewport, `drawerOpen` is memory-only and belongs to
the **narrow** one. Auto-collapsing therefore falls out for free — `drawerOpen`
starts `false`, so narrowing hides the sidebar and widening restores the saved
choice — *without* writing to prefs, which is the whole point of the split: a
resize is not a decision, and one narrow episode must not persist as "hidden"
on the big screen. The one explicit `watch(narrowViewport)` only resets
`drawerOpen`, so a drawer left open does not spring back on the next narrowing;
`closeSidebar()` touches only `drawerOpen`, which is what makes Esc and the
navigation watch in `AppShell` no-ops on a wide viewport. `narrowViewport` is
exported `readonly`: it is derived from `matchMedia`, and a consumer assigning
it would desync the app from the viewport until the breakpoint is next crossed
— including the specs, which drive `stubViewport` (`test/viewport.ts`) instead,
so the listener wiring is actually exercised.

The breakpoint is Tailwind's `lg` as `SIDEBAR_NARROW_QUERY`, written as its
**exact complement**: `not all and (min-width: 64rem)`. Tailwind v4 breakpoints
are rem-based (`lg` emits `@media (width >= 64rem)`), so a px query drifts from
every `lg:` utility once the root font size is not 16px, and negating with a
`max-width` always leaves a gap — no number of nines makes the two bounds meet.
On a narrow viewport the open sidebar **overlays** the content as a drawer
(`fixed … z-40` + a `z-30` backdrop in `AppShell`) rather than squeezing it,
since the reason to hide it there is that tables have no width to spare;
`BaseDialog` portals to the body with `z-40`/`z-50` and lands later in the DOM,
so dialogs still cover both. It is a **modal** drawer: the content column goes
`inert` while it is open — unfocusable, unclickable and out of the accessibility
tree in one attribute, which is also the focus trap (with nothing else focusable
the Tab cycle stays inside; no JS loop). Bound as `modal || undefined`, since
`inert` is not one of Vue's special boolean attributes and `:inert="false"`
would render `inert="false"`, which is still inert. There is deliberately **no**
body scroll lock: html/body/#app are `h-full` and the scroller is `<main>`,
inside the inert subtree, so the lock would be a no-op — what a drag on the
backdrop needs is its own `touch-none overscroll-none`. Focus enters the drawer
by the same handoff that moves the toggle. Dismissal is the backdrop, Esc and
any link in the sidebar. Esc is checked against `defaultPrevented` and the drawer being open: a
nested handler (`ContextListbox`, a dialog) cancels its own Escape but does not
stop it reaching `window`, so closing a popup used to close the drawer under it.
The links close it **themselves** rather than relying on `AppShell`'s route
watch — tapping the entry for the page already open changes no `fullPath`, and
the drawer would stay over the content it just "navigated" to.

`Sidebar.vue` hides with **`v-show`, not `v-if`**: the component stays mounted,
so collapsing does not reset `ui.sidebarSearch` or `collapsedSections` (whose
defaults are derived once per page load, `defaultsApplied`), and `display: none`
takes the contents out of the tab order — hiding by width alone would need
`inert`.

The toggle itself is one component, `layout/SidebarToggle.vue`, mounted in
**two** places and `v-if`'d at both call sites: the sidebar's own header
(right of the product name) while it is open, the TopBar while it is hidden —
the control sits at the edge of what it controls, and an open sidebar covers
the TopBar's left edge in drawer mode anyway. Because it moves, whatever hides
the sidebar takes the focused element with it, so the store leaves a **one-shot
focus handoff** (`requestToggleFocus` from `toggleSidebar` and from a
`closeSidebar` that actually closed something — never from the no-op one, which
runs on every navigation) and the instance mounting in its place claims it in
`onMounted` via `consumeToggleFocus`. `closeSidebar(false)` is the other half of
that rule: a **dismissal** (Esc, the backdrop) leaves the user where they were,
so the focus must be caught, while a **navigation** (every sidebar link, the
route watch) hands them new content whose start is where the focus belongs —
claiming it back onto the hamburger would be a jump backwards on every link. Not a `document.querySelector` for the
other button: that depends on an "exactly one is mounted" invariant living in
two other files and can focus a `display: none` one. Consequently neither header
may be tested by button position — both specs find it by
`aria-controls="app-sidebar"`.

`ClusterName` follows the toggle into the TopBar (`inline`, the same component
with the sidebar row's border/padding dropped — one label, so the two cannot
drift): it lives in the sidebar, the sidebar hides itself on a narrow viewport,
and which cluster a delete or an exec is about must not depend on reading the
tab title. The **switcher** stays in the sidebar — it is a list, not a label,
and the narrow TopBar has no room for it.

Collapsing also changes the width of the **content**, with no window resize
event to go with it. `TerminalView` therefore fits on a `ResizeObserver` over
its host rather than on `window.resize`: an exec pty kept its pre-collapse
geometry and wrapped output at a column that was no longer there. (Charts
already observed their container.)

Its glyph follows the position: inside the panel it collapses it is
`sidebar-collapse` (the conventional framed-layout-with-a-chevron, drawn for
this set — Heroicons has no panel icon), and in the TopBar it is the `bars-3`
hamburger, which is what a menu button in a header means. A hamburger sitting
*inside* the open sidebar reads as "open something" next to the thing already
open.

`ui.narrowViewport` is the app's one **behavioural** responsive signal — what
changes which controls exist — while pure layout stays in CSS breakpoints, which
cost no state and can differ per element. So `ThemeToggle` rides on the store
(its three-segment radiogroup is the widest control in the header, and on a
narrow viewport it collapses to a single button cycling Auto → Light → Dark →
Auto), while the TopBar's own crowding is `sm:`/`md:` utilities: a header row is
laid out against its **min-content** width, so the captions ("Cluster",
"Namespace") drop below `sm` — the namespace one to `sr-only`, never `hidden`,
since it is the select's accessible name. Without that,
`system:serviceaccount:<ns>:<name>` alone overflowed the row and the labels
printed on top of each other.

What is left is a **shrink order**, not a set of breakpoints — the mistake worth
not repeating was sizing the identity with `md:`/`sm:` cutoffs, which blanked it
while a third of the row stood empty (that is what the kubeconfig mode looks
like: no Sign out). Controls (toggle, theme, Sign out) are `shrink-0`; the
identity is `min-w-0 truncate` capped at `16rem` and takes whatever room is
left, with the whole value in a `title`; the namespace select shrinks after it.
`ClusterName` inline is `shrink-0` under a `max-w-[8rem] sm:max-w-[12rem]` cap
instead — a bounded label, not a shrinking one, because shrinkage is
distributed by content width and a long identity was crushing a four-letter
cluster to "t..". The identity's one absolute rule is the phone floor
(`max-[30rem]:hidden`, which Tailwind v4 compiles to
`@media not all and (width>=30rem)`): below that the pressure would fall on the
cluster name, and which cluster this is outranks who is signed into it.
Verified by rendering the row at 500–760px against the built CSS
(`header.scrollWidth === clientWidth` throughout, identity truncating from 206px
down to 88px), not by reading the classes. That button is deliberately **not** a one-option
radiogroup — only the current mode is on screen, so `aria-label`/`title` state
both what is set and what a click will do ("Theme: Light theme. Switch to Dark
theme"). Rendered with `v-if`/`v-else`, not by hiding one variant with CSS: two
sets of the same controls in the DOM would be two of everything to a screen
reader.

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

`MetricsChart.vue`'s card root carries **`min-w-0`**, and that is what makes the
chart follow a resize at all: uPlot sizes its own root in pixels, so as a grid
item (`xl:grid-cols-2` on every page that shows charts) the card's automatic
minimum is the canvas already drawn — it would never shrink, its
`ResizeObserver` would never fire, and the chart kept the width it had before
the window or the sidebar took it away, pushing the whole page into a horizontal
scroll. Growing always worked; only shrinking needed the class. Measured in a
browser: a 644px container left the card at 934px without it. The same shape as
`BaseSelect` above — a pixel-sized child under a `min-width: auto` layout item —
and worth checking first whenever something "does not fit after a resize".

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
checked with `kube.IsDNS1123Subdomain` in `handler.go`. That validator lives in
`internal/kube/names.go` because the exec auth frame's pod name
(`exec/protocol.go`) is the same kind of gate in front of the same kind of
interpolation, and the two used to be byte-identical copies: relaxing one breaks
no build and no test in the other, so an agreement test (`names_test.go`) now
makes such an edit visible. It is deliberately **not** apimachinery's
`IsDNS1123Subdomain`, which is stricter (it requires dots to separate non-empty
labels), so swapping it in would change what both call sites accept.
An advertised `preferredVersion` failing that
check falls through to the first *usable* entry in `group.Versions` rather than
failing the probe, so one unusable entry cannot hide a valid version behind it.
The resolved version is cached per context for 5m, and both ways out of that
cache exist because `cacheGroupVersion` alone had no counterpart: a version the
server stopped serving was replayed — and its 404 forwarded, reporting a live
metrics-server as absent — for the rest of the TTL. It is dropped by a **503, or
a 404 on a *collection*** (`Handler.fetch`'s `collection` parameter), and by a
**capability probe that comes back anything but available**. The collection
qualifier is the load-bearing half: metrics-server answers 404 for any pod it has
not scraped yet, so treating a single-object 404 as a version failure evicted a
cluster-global, per-context entry on every 15s poll for a new pod's first minute
— for every user of that context. The probe-side drop covers the opposite gap:
`useClusterSummary`'s node metrics never probe, so without it a data request kept
taking the cache-hit path into a group version the probe had already found gone.
The frontend polls ≥15s only while the tab is visible, into in-memory ring
buffers (240 samples, deduped by source timestamp). The floor is one constant
for every metrics caller (`METRICS_MIN_INTERVAL_SECONDS`/`metricsIntervalMs` in
`utils/metricsRanges.ts`) — `useMetricsPolling` and `useClusterSummary` run side
by side on the Overview against the same endpoints, so they must not each carry
their own copy of it. `usePollingLoop` owns the cadence itself: **no** path
starts a poll sooner than `intervalMs` after the last one, the catch-up when a
hidden tab returns included (it used to fire per visibility flip, so ten
alt-tabs meant ten cluster-wide pod walks; it now replaces the pending timer
rather than running beside it). Holding that guarantee needs an **`inFlight`
counter**, because `lastTickMs` is stamped on *entry*: a tick outlasting the
interval let the catch-up through, `clearTimer()` could not recall a timer that
had already fired, and the loop split into two self-sustaining chains with the
same generation — permanently, one more per flip, invisible because the callers'
own seq guards discard the duplicate *data* but not the duplicate walk. So the
catch-up returns while a poll is in flight (that poll *is* this cycle's, and its
own `.finally` re-arms), and the timeout callback nulls `timer` as it fires so
`clearTimer` only ever cancels something genuinely pending. It is a counter, not
a flag: a restart briefly overlaps the old generation's last tick with the new
one's first. And it is counted **per generation** (a `Map`, entries deleted at
zero), because the only question the catch-up asks is whether *this* cycle's poll
is already running: one global count answered for abandoned generations too, so a
slow tick a `stop()`/`start()` left behind — whose own `.finally` re-arms nothing,
`g !== gen` — suppressed the catch-up for the live chain until it settled, and
forever if it never did. A caller must therefore **restart the loop** rather than call its
own refresh directly — `stop()` then `start()`, as `ProblemPodsCard` and now
`useClusterSummary`'s context watch both do; a bare `refresh()` stamps nothing
and leaves the armed timer to fire behind it (measured: two cluster-wide
summaries 200ms apart on a switch). The buffers live in a shared
cache (`utils/metricsCache.ts`) keyed per axis by context-prefixed scope
(`<ctx>:pod:<uid>:cpu`, `<ctx>:node:<name>:cpu`, `<ctx>:ns:<namespace>:cpu`,
`:mem`), so history survives screen/tab switches and a late response from the
previous cluster never lands in the new cluster's buffer (node/namespace names
collide across clusters, hence the prefix). The three chart owners
(`PodMetricsTab`, `NodeMetricsTab`, `NamespaceOverviewPage`) rebind their
`shallowRef` to the cached buffer on scope **or** context change rather than
clearing it (a per-scope key also stops node→node series from blending), and they
bind **both axes in one `getMetricsBuffers(cpuKey(), memKey())` call**, which
protects the whole set from eviction. Per-key protection was not enough: at the
capacity bound the second bind evicted the first, since a just-created buffer has
no samples yet and the empty-buffer rule picks it first — so the cpu series was
dropped from the cache deterministically while mem survived, the chart on screen
looked fine (the component still holds the handle) and the history vanished on
the next remount. `getMetricsBuffer` is the single-scope form of the same call.
The cache is memory-only (a refresh clears it), bounded (TTL 1h — the widest
chart range — plus a 64-scope cap evicting the scope with the oldest
newest-sample, so an actively updating chart never goes before a stale one) and
adds **no** new browser storage.

Those three watches are also gated on `auth.isAuthenticated` (and `stop()` the
loop when it is false), like every sibling context watch: `start()` probes
`/api/ui/metrics/capabilities` immediately, and after a switch to a cluster with
no session that request carries no bearer, so its 401 ran the global handler and
replaced the switcher's `/login?redirect=<view>` with a bare `/login`.

`utils/podMetricsSeries.ts` reserves the `total` and `other` series labels: both
are valid DNS-1123 names, so a container called either one silently replaced the
pod aggregate (a line still labelled "total" plotting one container) or was
swallowed by the rollup. Such a container is rendered as `<name> (container)`,
on the **single-container branch too** — the reserved labels belong to the buffer,
not to one branch, and a lone container named `total` wrote the aggregate's series
until an ephemeral debug container arrived (same pod uid, so the same cached
buffer stays bound) and the multi-container branch spliced the pod aggregate onto
its history under one label. Ending a session wipes its series so a re-login never shows the
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
from three calls — `GET /k8s/api/v1/nodes` (allocatable cpu/memory/pods via
`parseQuantity` in `utils/units.ts`, plus Ready conditions),
`fetchAllNodeMetrics` (usage; null when metrics are absent, gauge shows "—") and
a one-page `fetchPodCount` (`includeObject=None` Table + `remainingItemCount`).
A forbidden node list (namespace-scoped tokens) hides the whole row; the Pods and
Nodes gauges link to their lists.

The usage call is **capability-gated**, through the same
`/api/ui/metrics/capabilities` probe the charts on this page use: without it a
cluster with no metrics-server paid a doomed `fetchAllNodeMetrics` on every tick
for as long as an Overview tab stayed open. The gate is `usePollingLoop`'s, so it
runs once per `start()` and is re-run on the context watch's restart (two
clusters genuinely differ) — but unlike `useMetricsPolling`'s it **always returns
true**: it gates one of the three calls, never the loop, since the node totals,
the Ready count and the pod count owe metrics-server nothing and absent usage is
already a rendered "—". Two defaults make that safe. The flag starts **true**, so
a `refresh()` called outside the loop with nothing probed yet still tries once
rather than reading "not probed" as "absent"; and a **failed** probe falls back
to trying the call, since guessing absent would blank the usage gauges of a
cluster that does have metrics-server over one bad round trip. Only a definite
non-`available` verdict turns the call off, and the verdict is assigned outright
on every probe so none can outlive the cluster it was taken for. The probe's own
write is guarded by a `gateSeq` bumped in the loop's `onStop`, exactly as
`requestSeq` guards `refresh()`'s: the loop's generation is not live while its
gate runs.

Two of those ride the metrics cadence; the node list does **not**. It is the one
expensive call — the API cannot project fields out of a list, so it transfers
whole node objects (**~21 KiB each** measured against a real cluster,
`status.images` a third of it) to produce four scalars and a Ready count: ~0.6
MiB/min for 7 nodes and ~8 MiB/min at 100, per open Overview tab. So it gets its
own `NODES_INTERVAL_MS` (60s) inside the same loop — not a second
`usePollingLoop`, which would duplicate the visibility/catch-up machinery — with
the derived totals cached between fetches, plus `resourceVersion=0` so the
apiserver serves it from its watch cache instead of a quorum read from etcd
(seconds of staleness, which is what a capacity gauge is). Allocatable and Ready
move when a node joins or goes down, not between samples; usage and the pod count
are the numbers that actually change.

Three properties of that cache are load-bearing. The **context watch clears it**
beside `data.value = null` — allocatable totals describe *a* cluster, and without
it the new cluster's gauges render the previous one's capacity for up to a minute
with the new cluster's usage plotted against it, which reads as a real
utilisation number rather than as missing data. It is cleared there and not in
the loop's `onStop`, which every stop() runs (unmount, and the stop() inside
every restart) without the cluster having changed. A **failed** node fetch keeps
today's meaning exactly — `available = false`, hiding the row — and leaves the
freshness stamp untouched, so the next tick retries at the metrics cadence rather
than hiding the gauges for a full minute over one transient error; only an actual
attempt can say the row is unavailable, since a skipped fetch resolves as `null`.
And the stamp is taken on **entry**, like `usePollingLoop`'s own throttle, so what
is bounded is how often the list is requested regardless of how long it takes.

The Pods gauge also carries the problem-pod count: `GaugeCard`'s optional
`alertPercent`/`alertLabel` paint a rose segment over the **end** of the filled
arc (`alertOffset`) plus an "N in trouble" line under the detail. It closes the
arc rather than starting it — drawn at the start it reads as a notch cut into
the ring, with the fill's own round cap poking out ahead of it — and keeps the
fill's round cap, so the two outer caps coincide and the ring ends in one tip.
The segment is floored at `MIN_ALERT_ARC` (2%), since a few bad pods out of a
cluster's capacity is otherwise an invisible sliver, and capped by the fill. The share is taken **against capacity**, the same
denominator as the arc it colors. The count is *not* computed here: it comes
from `ProblemPodsCard`'s scan below via a `count` event the page relays
(`NamespaceOverviewPage`), so the cluster is walked once rather than twice. The
event carries the scan's truncation as well, so a capped scan reads "137+ in
trouble" exactly as the card's own heading marks it. `null` (no scan yet, or a
failed/forbidden one) is distinct from 0 and draws no segment at all — a failed
scan must not read as a clean bill of health — and is emitted **only** on a
context switch: a plain rescan keeps the last count on the gauge instead of
blanking the segment for the length of every scan.

Below the gauges — still cluster-wide, so it ignores the namespace selector —
`components/pod/ProblemPodsCard.vue` lists pods in trouble across all
namespaces, and renders **nothing at all** when there are none (the common
case: a card that is only ever on screen when it has something to say). Rows
come from the same pods Table the list page uses, through `listAllAsTable`
(bounded 6×500) and `ResourceMiniTable` with the list page's columns
(Ready/Status/Restarts/Age) plus Namespace and the printer's wide **Node**
column (failures sharing one node are the diagnosis), capped at 50 rendered rows
("50 of 137"; a `+` marks a scan that hit the page cap). The scan is
deliberately **not** narrowed by a field selector: the case that matters most,
CrashLoopBackOff, has `status.phase=Running`, so no server-side filter can
express "unhealthy" — hence a full walk, on its own 60s loop
(`usePollingLoop`, visibility-gated) rather than the metrics cadence, plus a
Refresh button that restarts the loop. A **403** hides the card outright
(listing pods cluster-wide needs cluster RBAC and a namespace-scoped token must
not turn the Overview into a permission error); any other failure renders in
place.

The verdict is pure and shape-based, in `utils/podHealth.ts`: `error` (the
Status cell is a failure — the fallthrough branch, so every unknown/new failure
reason counts), `not-ready` (Running with `Ready n/m`, n<m) and `stuck` (a
transitional status — Pending/ContainerCreating/PodInitializing/`Init:x/y`/
Terminating — outlasting `STUCK_GRACE_MS`, 15m). The grace is what keeps the
card quiet during a rollout, and it also applies to `not-ready` (readiness
probes have warm-ups) measured from the pod's **own age**, so a long-running
pod going unready is reported at once. Terminating is measured from
`deletionTimestamp`, not creation — otherwise every deleting pod would read as
stuck. A missing/unparseable timestamp counts as old (surface, don't hide), and
a Table with no Status column (the List→Table fallback) yields no verdict at
all.

**Terminal** failures age out (`TERMINAL_MAX_AGE_MS`, 6h): a pod that has
already finished — `TERMINAL_STATUSES` (Evicted/Error/OOMKilled/
DeadlineExceeded/NodeAffinity/`OutOf*`/…) — is news for a while and noise
afterwards, and a few Evicted leftovers or the pods a CronJob's
`failedJobsHistoryLimit` retains would otherwise keep the card on screen
forever. A *recurring* failure never ages out: CrashLoopBackOff,
ImagePullBackOff, CreateContainerConfigError are the kubelet still trying.
The clock is `statusAgeMs`, from `metadata.managedFields` — the kubelet owns
`status`, so the latest entry with `subresource: "status"` timestamps the last
state change. It is the only "when did it fail" signal in a Table row:
`creationTimestamp` dates the pod, and an eviction hits pods that have run for
weeks, so a creation-age bound would hide exactly the fresh evictions worth
seeing (there is a test for that shape). Table rows really do carry
managedFields (verified against a live apiserver), but when the age is
unknowable `statusAgeMs` returns **null** and the pod stays listed — the caller
only ever ages pods *out*, so no answer must not mean "hide".

## Testing conventions

- Go: fake upstreams via `httptest` + hand-built `kube.Upstream`; exec tests
  dial a real WebSocket against `httptest` with an injected `ExecutorFactory`
  fake. Leak tests assert sentinel tokens never appear in logs/errors.
  `config`'s `TestMain` unsets every `KUBE_CONSOLE_*` plus `KUBE_API_SERVER`/
  `KUBE_CA_FILE` before running: `Load` reads the process environment, so a
  variable left in the developer's shell (after a local
  `--use-kubeconfig-credentials` run, say) otherwise fails the whole package on
  `validate`, with messages about a test's own setup that it never made. By
  prefix, not by a list, so a new setting cannot bring it back.
- Frontend: vitest + jsdom. `web/src/test/setup.ts` polyfills localStorage/
  sessionStorage (Node ≥22 shadows jsdom's), ResizeObserver (needed by
  @tanstack/vue-virtual) and matchMedia (uPlot calls it at import time, so any
  test whose import graph reaches a chart needs it); component tests stub
  `getBoundingClientRect` **and `offsetWidth`/`offsetHeight`** so the virtualizer
  renders rows. The offsets matter as much as the rect: this @tanstack/virtual-core
  measures the scroll element through them, they are always 0 in jsdom, and
  without the stub the virtualizer rendered **zero** rows after mount — so every
  post-`setProps` row assertion in `ResourceTable.spec` was passing against an
  empty DOM. A row assertion that cannot fail is worse than no test; check that
  new ones actually see rows.

## Gotchas

- Tailwind: never put a static text-color utility on an element that also gets a
  conditional one — stylesheet order decides the winner, not class order (this
  once made red `Failed` statuses render neutral). Pick the full class in one
  expression.
- `vite build` empties `web/dist`; `web/dist/.gitkeep` must exist for
  backend-only builds (the Makefile re-touches it). `web/dist` is in
  `.dockerignore` and must stay there: the Docker build's `COPY . .` would
  otherwise bring the host's previous bundle into the stage, the following
  `COPY --from=web` **merges** without deleting, and `go:embed all:dist` would
  bake another branch's content-hashed assets into the binary. CI never sees it
  (only `.gitkeep` is tracked), which is exactly why it stayed invisible.
- Status color-coding applies only to status-bearing columns (`isStatusColumn`),
  otherwise names like "error-page" light up red. The classification itself is
  `statusSeverity` (`"error" | "warning" | null`), which reads a cell **by its
  comma-separated parts**, worst severity winning: the Node printer emits STATUS
  as a joined condition list, so matching the whole cell left every cordoned node
  neutral — including `NotReady,SchedulingDisabled`, which rendered exactly like a
  healthy one, while a bare `NotReady` was red. `statusTextClass` is the *color
  mapping* of that severity, and anything needing something other than text color
  must take the severity: `eventRowClass` used to tint whole rows by searching the
  returned class for `"red"`, so repainting error text to a `rose-` palette (which
  `GaugeCard` already uses) would have silently downgraded every error row to
  amber, with no test covering it. For the same reason the event **Type** cell
  goes through `statusTextClass(row.type)` in both `EventsCard` and
  `RecentEventsCard` instead of hardcoding the amber pair: that literal *is*
  `SEVERITY_TEXT_CLASS.warning`, and two copies of it meant a repaint left two
  columns of the same table in different colors. The neutral end of the same
  mapping is `NEUTRAL_TEXT_CLASS`, exported beside it.
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
