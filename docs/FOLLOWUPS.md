# Orca — deferred follow-ups (post sub-project #1)

Sub-project #1 (orchestration backend `orca serve`) ships with the **boolean guardrail
gate** and **sequential autopilot** (`max_sessions: 1`, the documented default). The items
below are deliberately deferred — each is a self-contained next task, not abandoned work.

## 1. Decision engine (wire the `inference` module) — ✅ DONE

The overseer LLM gate is wired into `MissionEngine` via the optional `decideTask` hook
(`bootstrap.ts` builds it from the shared `overseerClient()` factory, reused by the deriver's
`decideApproval`). Before dispatching a **guardrail-triggering** task, the engine consults the
relay model (`decideTask` in `overseer/decision.ts`); a denial — or a destructive verdict —
escalates the task to a human by setting it `blocked` (excluded from readiness) instead of
spawning. No relay configured → no-op (approve, non-destructive) so the boolean guardrail
behaviour is unchanged. Covered by `tests/overseer/decision.test.ts` + `missionEngine.test.ts`.

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
- **Stuck-session recovery:** ✅ DONE. `overseer/stuckDetector.ts` runs every 60s: an
  `in_progress` task whose agent tmux session is gone (agent died without `orca close`) is reverted
  to `open` so the mission re-spawns it, bounded by a `stuck:<n>` relaunch counter — after
  `maxRelaunch` deaths it escalates to `blocked`. A 2-min grace (via the `started:<ms>` label) avoids
  reaping a task mid-launch. The startup zombie reconcile shares the `deadAgentTasks` predicate.
  (A "silent but alive" stall detector — agent hung at a prompt — is still future work.)

## Multi-project orchestration — ✅ loops done, full API tenancy deferred

The orchestration **loops are project-agnostic**: `MissionEngine` resolves each mission's project
from its epic's `project_id` (no fixed project), `Scheduler.tick` iterates every registered project,
and the startup zombie reconcile + stuck detector + `taskForSession` span all projects. `POST /tasks`
and `POST /tasks/plan` accept an optional `project_id` (gated by `canAccessProject`), `POST /sessions`
and `GET /tasks/:id/usage` resolve the task's own project path, and `/tasks/:epicId/phases` now
inherits the epic's project (was a latent hardcode to project 1).

**Deferred (security-sensitive):** the auth surface is still **home-project-centric**. The `GATED`
middleware authorizes `/tasks`, `/missions`, `/sessions`, `/activity`, `/events` against the
daemon's single home project, and `GET /tasks` / `GET /missions` return all projects' rows. Full
per-resource multi-tenant authz (gate each task/mission/session by *its* project, filter list
endpoints to the caller's accessible projects) is a separate slice — do it before exposing
multi-project to non-admin users in a shared deployment.

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
