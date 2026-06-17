# Orca — deferred follow-ups (post sub-project #1)

Sub-project #1 (orchestration backend `orca serve`) ships with the **boolean guardrail
gate** and **sequential autopilot** (`max_sessions: 1`, the documented default). The items
below are deliberately deferred — each is a self-contained next task, not abandoned work.

## 1. Decision engine (wire the `inference` module)

**Status:** `src/inference/` (`RelayClient` + `FakeInference`) is built and unit-tested, and
the relay config is plumbed into `buildApp(opts.relay)` — but it is **not yet consumed**. The
overseer currently decides purely from autonomy level + cleared guardrails.

**Next task:** add an overseer decision step that consults `mimo-v2.5` via the relay
(`InferenceClient.decide`) for approve/redirect judgments before spawning a guardrail-triggering
task. Construct `RelayClient` in `bootstrap.ts` when `opts.relay` is set and inject it into
`MissionEngine` as an optional decision hook (relay absent → unchanged boolean behavior). This
is Filip's "the LLM decides about tasks" layer.

## 2. Concurrency hardening (only matters at `max_sessions > 1`)

At the sequential default these are inert; they become real when parallel agents are enabled:

- **`nameAgent` uniqueness** (`bootstrap.ts`): `Agent${performance.now() % 9999}` can collide
  for two spawns in the same millisecond → duplicate `orca-<name>` tmux session + agent row.
  Fix: a monotonic counter or a uniqueness check against live sessions.
- **`sessionTaskId` resolver** (`bootstrap.ts`): returns the first `in_progress` task regardless
  of session, so every concurrent session derives against the same task. Fix: have
  `SpawnService` record a `session → taskId` map and resolve from it.
- **Per-mission running count** (`missionEngine.ts`): the cap counts ALL `orca-*` sessions
  globally, so two concurrent missions interfere. Fix: attribute sessions to missions.
- **Stuck-session recovery:** if an agent dies without `jt close`, its task stays `in_progress`
  and the mission never advances (no liveness sweep). Fix: a stall detector (silent > N min →
  nudge → relaunch → escalate), as jat had.

## 3. API surface completion (spec §5 routes not in #1)

Task 17 scoped a subset. Spec §5 also lists: `GET /tasks/:id/tree`, `POST /tasks/:id/deps`,
`GET/POST /agents`, `GET /projects`, `POST /sessions` (spawn), `PATCH /missions/:id`
(pause/resume). Add as the CLI/frontend needs them; `POST /tasks/:id/deps` is the most useful
(currently deps are only settable via the internal `TaskStore.addDep`).

## Web shell (#2) deferred

- Explicit SSE reconnect backoff (spec §8) — relying on native EventSource auto-reconnect for now.

## Auth hardening (post auth-users slice)

Auth tokens are stored in localStorage and passed to SSE via `?token=` query param (EventSource can't set headers; cross-origin cookies need HTTPS). Harden for production: TLS-terminating non-buffering reverse proxy + `Secure;HttpOnly;SameSite` cookies; add login rate-limiting; the LoginGate is presence-based and does not auto-redirect on mid-session token expiry.

## Web deploy: SSE must NOT go through the Next rewrite proxy

Confirmed live (chrome-devtools): Next.js `rewrites()` BUFFER SSE responses — a browser
`EventSource` to `/orca-api/...` receives ZERO events (terminal stream + `/events` realtime both
dead). The daemon is directly reachable from the browser at `http://<host>:4400` with open CORS, and
direct `EventSource` streams live. **Deploy builds with `NEXT_PUBLIC_ORCA_URL=http://<host>:4400`**
(direct daemon URL) so fetch + SSE bypass the buffering proxy. The `/orca-api` rewrite in
`next.config.ts` is now unused — remove it, or replace the whole approach with a streaming Route
Handler (`app/orca-api/[...path]/route.ts` returning the piped fetch body) if same-origin is needed
(e.g. behind HTTPS where mixed-content blocks a direct HTTP daemon call). For the current HTTP preview,
the direct URL is correct and verified.

## L2-6 cleanup (non-blocking, from final review)
- `web/components/auth/LoginGate.tsx` imports `EventBridge` from `app/providers` (components→app layering). Cleaner: relocate `EventBridge` to `web/components/EventBridge.tsx` and import from there in both `providers.tsx` and `LoginGate.tsx`.
