# Orca — deferred follow-ups (post sub-project #1)

Sub-project #1 (orchestration backend `orca serve`) ships with the **boolean guardrail
gate** and **sequential autopilot** (`max_sessions: 1`, the documented default). The items
below are deliberately deferred — each is a self-contained next task, not abandoned work.

## 1. Decision engine (wire the `inference` module)

**Status:** `src/inference/` (`RelayClient` + `FakeInference`) is built and unit-tested, and
the relay config is plumbed into `buildApp(opts.relay)` — but it is **not yet consumed**. The
overseer currently decides purely from autonomy level + cleared guardrails. The `decideApproval`
hook is wired in the deriver for prompt-level decisions, but the mission engine tick still
uses boolean guardrail logic only.

**Next task:** add an overseer decision step that consults the configured relay model
(`InferenceClient.decide`) for approve/redirect judgments before spawning a guardrail-triggering
task. The relay is already constructed in `bootstrap.ts` and injected into the deriver's
`decideApproval`; extend this to `MissionEngine` as an optional decision hook (relay absent →
unchanged boolean behavior). This is the "the LLM decides about tasks" layer.

## 2. Concurrency hardening (only matters at `max_sessions > 1`)

At the sequential default these are inert; they become real when parallel agents are enabled:

- **`nameAgent` uniqueness**: the `uniqueName()` function cycles through a fixed name list;
  when two concurrent missions spawn agents simultaneously, names could still collide if the
  counter hasn't advanced. Fix: a monotonic counter with a uniqueness check against live sessions.
- **`sessionTaskId` resolver** (`bootstrap.ts`): resolves a session's task via the `agent:<name>`
  label (most recent match). This is correct for single-mission scenarios but could pick a
  stale task if agent names repeat across missions. Fix: have `SpawnService` record an explicit
  `session → taskId` map.
- **Per-mission running count** (`missionEngine.ts`): the cap now counts the mission's own
  `in_progress` children (not all global `orca-*` sessions), so parallel missions no longer
  interfere directly. However, global tmux session limits could still cause indirect starvation.
- **Stuck-session recovery:** if an agent dies without `orca close`, its task stays `in_progress`
  and the mission never advances (no liveness sweep). Fix: a stall detector (silent > N min →
  nudge → relaunch → escalate), as jat had.

## 3. API surface completion

Most spec routes are now implemented: `GET /projects`, `POST /projects`, `GET /projects/:id/git`,
`POST /sessions`, `GET /sessions/:name/pane`, `POST /sessions/:name/keys`, `POST /sessions/:name/resize`,
`GET /missions/:id`, `PATCH /missions/:id` (pause/resume), `GET /activity`, `GET /config`, `PUT /config`.

Still missing:
- `GET /tasks/:id` — single task detail endpoint (currently only accessible via list + filter)
- `GET /tasks/:id/tree` — dependency tree visualization
- `POST /tasks/:id/deps` — dedicated add-dep endpoint (deps are settable via `PATCH /tasks/:id` with `deps` array)
- `GET/POST /agents` — agent registry endpoints (the `agents` table exists but has no API surface)

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

## Events table retention (from L2-5 timeline slice)

The `events` table grows unbounded; add a retention/pruning policy (e.g. keep last N or last 30d) before long-running production.
