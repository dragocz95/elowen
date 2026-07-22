# Bugs / correctness review — 2026-07

Four area agents. Overall the codebase is unusually rigorous (generation fences,
birth-identity process kills, bounded timers, boundary validation). Findings below are the
defects that survived tracing, grouped by area, highest severity first.

---

## src/daemon · src/api · src/push

### 1. Cross-tenant leak: `GET /tasks/ready` ignores tenancy + multi-project — Medium, CONFIRMED
- `src/api/routes/tasks.ts:66` — `app.get('/tasks/ready', c => c.json(d.readiness.ready(d.project.id)))`, no `accessibleProjects` filter, hard-coded to the home project.
- A non-admin (or agent token scoped to project B) passes the middleware gate (`src/api/middleware.ts:64` only requires ≥1 project) and receives the home project's ready tasks incl. titles/descriptions; project-B users never see their own.
- Fix: filter through `accessibleProjects(c)` like `GET /tasks` (ideally accept `?project_id`), restrict agent scope to `agentProjects()`.

### 2. `POST /plan/:jobId/submit` not idempotent — Medium, CONFIRMED
- `src/api/routes/tasks.ts:487-497`, `src/api/services/planService.ts:117-142`, `src/overseer/planJob.ts` (`setPhases` flips `done` without a guard).
- Submit doesn't check `job.status === 'planning'`; the job lives 10 min after completion (`TERMINAL_TTL_MS`). Double-submit (pilot retry / curl retry on timeout) appends the whole phase set a second time and re-calls `engine.engage`; submit on a `failed` job silently resurrects it.
- Fix: return 409 when `job.status !== 'planning'`.

### 3. `POST /users` — unvalidated body + misleading 409 — Low/Medium, CONFIRMED
- `src/api/routes/auth.ts:280-289` — only auth route without `parseBody`/schema. No password min-length (admin-create allows empty username + password), and the `catch` maps *every* error to 409 "username taken" (incl. TypeError from non-strings). `null` body → destructure TypeError → 500.
- Fix: zod `{ username: z.string().min(1), password: z.string().min(8) }`; catch only the UNIQUE violation as 409.

### 4. NaN in numeric params → 500 — Low, CONFIRMED (bind `NaN` → `datatype mismatch`)
- `src/api/routes/memory.ts:39` (`limit ? Number(limit)`), `:236` (`Number(cat)`), `:253/:264/:273/:282/:302/:314` (`Number(c.req.param('id'))`); same `Number(c.req.param('id'))` pattern in `src/api/routes/auth.ts` users routes.
- `GET /memory/events?limit=abc`, `GET /memory/abc`, `GET /users/abc/avatar/url` → NaN bind → unhandled → 500 instead of 400/404.
- Fix: `queryInt` (already in `validation.ts`) for query params; `Number.isInteger` check for `:id` → 404/400.

### 5. Setup-mode 500: routes read `c.get('user').id` without a user — Low, CONFIRMED (setup mode only)
- `src/api/routes/auth.ts:398` (`adminOnly` → `c.get('user').id`), `src/api/routes/brain.ts:144,150,155,164` (`c.get('user').is_admin` / `denyNonOwner`).
- Before the first user exists, auth middleware passes requests without `user` (onboarding). `GET /users/1/projects` or `GET /brain/managed-sessions` then → TypeError → 500. Neighbouring routes guard with `!actor || …`; these don't.
- Fix: `const u = c.get('user'); if (!u || …) return 403;`.

### 6. Push for standalone tasks never sent — Medium, PLAUSIBLE (may be intentional)
- `src/push/pushDispatcher.ts:40` does `payload.missionId ? recipientsForMission(…) : []`; but `src/push/messages.ts:45,71` (`buildNeedsInput`/`buildBlocked`) explicitly model `missionId?: undefined`.
- Scheduler-launched standalone task blocks / needs input → 0 recipients, despite `recipientsForMission` having an "admins only" fallback for exactly this.
- Fix: for no-`missionId` payloads notify admins (`d.users.list().filter(u => u.is_admin)`), or remove the missionId-less branches from `messages.ts` if intentional.

**Known/acceptable:** cron `jobs.json` read-modify-write is non-atomic vs the scheduler (acknowledged in a comment); `PATCH /plugins/:name/config` doesn't type-check values against `configSchema` (admin-only); web `CliSettings` lacks `telegramUserId` (missing feature, not a bug). Clean: `GET /config` secret redaction, avatar HMAC + timingSafeEqual, single-use WS ticket store, SSE cleanup + replay buffer, login rate-limit (nginx `x-real-ip`, spoofed headers stripped), daemon startup/shutdown.

---

## src/store

### 1. Deleting a user leaves brain history + push subs; `removeForUser` is dead code — HIGH, CONFIRMED
- `src/api/routes/auth.ts:290-305` (only delete path), `src/store/brainStore.ts:1146` (`removeForUser`, zero callers), `src/store/pushSubscriptionStore.ts` (no per-user cleanup), `src/store/schema.sql:56-57`.
- `DELETE /users/:id` cleans tokens/terminals/grants/prompts/settings/memory but never `brainStore.removeForUser` and never `user_push_subscriptions`. All `brain_sessions`/`brain_messages`/`brain_goals`/`brain_cards` rows survive, keyed by `user_id`.
- `users.id` is a plain `INTEGER PRIMARY KEY` (rowid, no AUTOINCREMENT) → SQLite reissues `max(id)+1`. Delete newest user N, create a new one → it gets id N and inherits the deleted user's transcripts (`listSessions(N)`, `searchMessages(N)`, `usageByDay(N)`); `pushSender.listForUsers([N])` sends the new user's notifications to the deleted user's devices. Even without reuse: unbounded retention of "deleted" users' private conversations.
- Fix: in the DELETE handler call `d.brainStore?.removeForUser(id)` (dispose live sessions first) and add + call `PushSubscriptionStore.removeAllForUser(id)`. The store method already exists and is tested — just never wired.

### 2. `GET /memory?offset=N` without `limit` → 500 — Medium, CONFIRMED (reproduced)
- `src/store/memoryStore.ts:138-141`; reachable via `src/api/routes/memory.ts:233-238` (limit/offset each independently optional).
- `list()` appends `OFFSET ?` even with no `LIMIT`; SQLite grammar only allows OFFSET after LIMIT → `near "OFFSET": syntax error`.
- Fix: when `offset !== undefined && limit === undefined`, emit `LIMIT -1 OFFSET ?`, or force a default limit whenever offset is present.

### 3. Retention janitor strands delegated sub-agent transcripts — Low, PLAUSIBLE
- `src/store/brainStore.ts:1057` (`deleteSession` detaches children: `SET parent_session_id = NULL`) vs `:429-441` (`staleConversationIds` excludes `brain-ch-%` + non-top-level).
- Sub-agent children are `brain-ch-subagent-*`. Janitor deletes stale parent → children become top-level but their `brain-ch-` prefix excludes them from `staleConversationIds` forever → unbounded growth, removable only one-by-one via admin.
- Fix: janitor-initiated deletes should remove the descendant tree (recursive-CTE `deleteSession`), or include aged orphaned `brain-ch-subagent-*` roots in `staleConversationIds`.

### 4. `bindChannelContext` re-keys without tearing down bound terminal — Low, PLAUSIBLE
- `src/brain/brainService.ts:707-733` (no `terminalTeardown`, unlike `deleteSession` :640 / `deleteManagedSession` :752); `src/store/brainStore.ts:1075-1092` (`reassignSession` re-keys 10 tables but not `brain_terminals.brain_session_id`).
- Bind conversation X (with an open `elowen chat` terminal) into a Discord channel → the `brain_terminals` row references a gone id; next `BrainTerminalService.sweep()` (`terminalService.ts:116-130`) reaps it as "conversationGone", killing the admin's live tmux + revoking the token.
- Fix: mirror `deleteSession`'s teardown in `bindChannelContext`, or re-key `brain_terminals.brain_session_id` inside `reassignSession`.

**Clean:** `USAGE_ROWS`/rollup incl. `TASK_SNAPSHOT_EXCLUSION` substr math, day bucketing, `enqueueSubagentResult` multi-`ON CONFLICT` upgrade, `persistCompaction` tail alignment, `runOnce` migration versioning, partial-unique identity indexes, `updateGoal` column whitelist.

---

## src/cli · src/terminal · src/tmux · src/spawn

### 1. tmux targets use prefix matching — keys/kills can hit the wrong session — High, CONFIRMED
- `src/tmux/driver.ts:12,35,42,49,53,59,67` (every `-t ${session}`).
- tmux `-t <name>` does exact match then *prefix* fallback; no call pins `=`. Session names have numeric suffixes: `elowen-advisor-<userId>` (`src/advisor/service.ts:86`), `elowen-overseer-<missionId>` (`src/overseer/overseerAgent.ts:56`). Users 1 and 10 both have advisors; user 1's exits; `tmux.kill('elowen-advisor-1')` (`src/advisor/service.ts:100`) prefix-matches `elowen-advisor-10` → **kills another user's session**. Same hazard for `sendKeys`/`sendRaw` (opencode Enter-nudge timers fire up to 13s after spawn, `src/spawn/spawn.ts:78-82`) and `capturePane`.
- Fix: pass `'-t', '=' + session` (exact) for kill/sendKeys/sendRaw/capturePane/capturePaneAnsi/resize.

### 2. Legacy diff rows with padded line numbers lose add/delete rendering — Medium, CONFIRMED
- `src/cli/chat/components.ts:661-666` (`diffLine`), `:707` (`renderDiffRows`).
- `PI_ROW = /^([-+ ])\s*(\d+) (.*)$/` is consulted before `LEGACY_ROW = /^\s*(\d+) ([-+ ]) (.*)$/`; a padded legacy row (`'   2 - old'`) also matches `PI_ROW` with sign `' '` → renders as context with the real `-`/`+` leaking into text. Repro'd: `'   2 - old'` → `sign=' ', text='- old'`. Existing test only asserts text presence, so it passes despite wrong colouring.
- Fix: prefer legacy parse when its sign is meaningful — `const useLegacy = legacy && (!pi || pi[1] === ' ');` — mirror in `renderDiffRows`.

### 3. SSE parser corrupts multi-`data:`-line frames — Low, PLAUSIBLE
- `src/cli/chat/brainClient.ts:70-75` (`parseSse`) — multiple `data:` lines must join with `\n`; here each is `.trim()`ed and concatenated with no separator. Latent (today's server emits single-line frames); a re-chunking proxy would corrupt JSON → dropped by the `catch` at :643 with no diagnostic.
- Fix: collect data lines and `join('\n')`; strip only the single leading space after `data:`.

### 4. `elowen down` / restart can signal a recycled PID — Low, PLAUSIBLE
- `src/cli/launcher.ts:57-64` (`stop`), `:102-104` (`isAlive`) — run-file PIDs killed/reused with only `kill(pid, 0)`, no birth-identity check (unlike `processTermination.ts`). Stale `run.json` after reboot → SIGTERM to an unrelated recycled PID; `start()` treats it as "already running" and skips spawning.
- Fix: validate identity before kill/reuse — confirm `/health`, or compare `/proc/<pid>/cmdline`.

### 5. `$VISUAL`/`$EDITOR` with a space in its path can't launch — Low, CONFIRMED
- `src/cli/chat/externalEditor.ts:13-15` — value split on all whitespace (to support `code --wait`), so `/opt/My Editor/bin/edit` splits into bogus argv → silent `null` ("editor exited without saving").
- Fix: shell-style quoting in the split, or document the limitation.

### 6. Minor process/pty hygiene — Low
- `src/cli/chat/processTermination.ts:488` — `BoundedChildTermination` SIGKILL timer not `unref()`'d (sibling at :451-455 is); hung editor keeps the loop alive for the grace period.
- `src/terminal/wsHandler.ts:44` — `attach(...)` in `onOpen` without try/catch; node-pty throwing at spawn escapes into the WS library instead of `UNSUPPORTED_CLOSE`.
- `src/terminal/bridge.ts:38` — pty→`ws.send` with no backpressure; a firehose pane against a slow browser buffers unboundedly.

**Clean:** shell-arg handling (argv arrays + `esc()` single-quote escaper `src/spawn/commandBuilder.ts:58`), `localShell.ts`/`processTermination.ts` bounded TERM→KILL with procfs birth-identity, Fenwick height index, viewport math, diff wrap gutters, frame scheduler, snapshot generation fencing, SSE reconnect backoff.

---

## src/brain

No Critical/High/Medium. Turn/steer/abort state machine, sub-agent drain, admission rollback,
overflow/compaction defer, `queueRemove` re-steer, stopSession lock ordering all traced and
correct. Three Low leaks:

### 1. Lock map in `LiveSessionRegistry` never releases keys — Low, CONFIRMED
- `src/brain/session/liveRegistry.ts:14` (`locks = new Map`), `:27-32` (`withLock`) — stores settled promise under key forever; nothing deletes. Every conversation adds `send-<id>` + `<id>`; idle rollover (30 min) mints new ids per revived conversation; channel rollover mints archival ids. Monotonic growth over months.
- Fix: in `withLock`, after settle `if (this.locks.get(key) === stored) this.locks.delete(key)`.

### 2. Throttle maps in `events.ts` leak entries for tool calls without an end event — Low, PLAUSIBLE
- `src/brain/events.ts:300` (`lastProgressAt`), `:310` (`lastAuthoringAt`) — cleared only on `tool_execution_start`/`_end` for a `toolCallId`. A turn aborted mid-authoring (model drafted a tool call, user Esc → no start/end for that id) leaves an entry forever. Guaranteed leak for authoring-only calls.
- Fix: also clear both maps on `agent_end`/`agent_settled`, or use a bounded LRU.

### 3. Mode-switch marker written to a session that then rolls over — Low, CONFIRMED (display-only)
- `src/brain/service/turnRunner.ts:270-275` (marker + `active.lastMode`) vs `:388-406` (rollover/vision-hop inside the `send-` lock). Marker recorded on `active` before the send-lock; `maybeRollover` disposes+replaces the session carrying only `listeners`, so the durable marker + its model-facing notice land in the archived conversation, not the one the turn runs in. Mode itself works (plan-mode reminder is rebuilt per turn); only the marker is lost.
- Fix: move mode detection (`:270-275` + `flushReasoningMarker`) inside `serial(send-…)` after `maybeRollover`/`maybeVisionHop`, onto the final `b`.

---

## Fable verification (2026-07-20)

17/19 CONFIRMED, 0 refuted. Corrections + new findings:

- **api#4 (NaN→500) — scope corrected**: only LIMIT-position binds throw (`datatype mismatch`).
  Real 500s are just `memory.ts:39` (`/memory/events?limit=abc`) and `:228` (`/memory?q=x&limit=abc`).
  The `Number(cat)` / `Number(c.req.param('id'))` cases land in WHERE binds → clean 404/no-op, NOT 500.
  So `GET /memory/abc` and `GET /users/abc/avatar/url` do **not** 500 — only the two `limit` reads need `queryInt`.
- **cli#1 (tmux prefix) — worse than stated**: not just kill. `sessions.ts:61-83` gates `keys`/`input`/`resize`
  on the **literal** name, so user 1 passes the gate for their dead `elowen-advisor-1` and tmux prefix-delivers
  the keystrokes into user 10's **live** advisor (holding user 10's full-rights token) → cross-user input injection.
- **store#2 wording**: repro'd failure is `near "?": syntax error` (not `near "OFFSET"`); same fix (`LIMIT -1 OFFSET ?`).
- **brain#2**: upgraded PLAUSIBLE→**definite leak** for authoring-only calls (Esc mid-draft never emits `_end`).

**New (not in the original doc):**
- **N1 — secrets in tmux scrollback** (Low/Med, CONFIRMED): `SpawnService.launch` (`spawn.ts:53,70` +
  `commandBuilder.ts:102-105`) inlines `export ELOWEN_TOKEN='…'` into the `send-keys` command → pane scrollback,
  readable via `capturePane`. `spawnArgv` (`driver.ts:14-27`) exists for exactly this but only `terminalService.ts:71`
  uses it. Fix: route worker/pilot/overseer/advisor launches through `spawnArgv` (env via `-e`).
- **N2 — PushSender sequential, no per-delivery timeout** (Low): `pushSender.ts:30-38` one hung endpoint delays
  every later device. Fix: `Promise.allSettled` / per-send AbortSignal timeout.
- **N3 — `DELETE /users/:id` with non-numeric id silently succeeds** (Low): `auth.ts:298-300` `Number('abc')`→NaN→no-op→`{ok:true}`.

**Fix order:** store#1 → cli#1 → api#1 → api#2 → store#2 → push#6 → the Low items.
