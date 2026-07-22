# Security review — 2026-07-20 (Fable)

Full pass over every REST route family, auth/tenancy middleware, the web BFF, crypto,
shell/tmux construction, and data-lifecycle stores. Ordered by severity.

## HIGH

### H1. `DELETE /users/:id` leaves private data → inherited by a new user via SQLite rowid reuse — CONFIRMED
- `src/api/routes/auth.ts:290-305`, `src/store/userStore.ts:126-137`, `src/store/schema.sql:56-57`.
- `users.id` is `INTEGER PRIMARY KEY` **without `AUTOINCREMENT`** → SQLite reuses the deleted highest
  rowid on the next insert. Delete cleans `auth_tokens`/`brain_terminals`/`user_projects`/`user_prompts`
  + `userSettings`/`memory*`, but **not** brain conversation data (`brain_sessions`/`brain_messages`/
  `brain_session_events`/`brain_subagent_runs`/`brain_subagent_results`/`brain_goals`/`brain_cards`/
  `brain_workflows`) nor `user_push_subscriptions`. `brainStore.removeForUser` (`brainStore.ts:1146`)
  exists, is complete, has zero callers.
- Exploit: create X (id=5) → delete X → create Y → Y gets id=5 → Y's `GET /brain/sessions|messages|search`
  surface X's private history; X's browsers receive Y's push notifications.
- Fix: in the delete path call `d.brainStore?.removeForUser(id)` (dispose live sessions first) + add and
  call `PushSubscriptionStore.removeAllForUser(id)` (`DELETE FROM user_push_subscriptions WHERE user_id = ?`).
  Consider `AUTOINCREMENT` on `users.id` as defense-in-depth.

## MEDIUM

### M1. `GET /tasks/ready` ignores tenancy — cross-tenant leak — CONFIRMED
- `src/api/routes/tasks.ts:66` — `c.json(d.readiness.ready(d.project.id))`, hard-coded to the home project,
  never consults `accessibleProjects(c)`. It IS in the agent-token allow-list (`middleware.ts:30`), so an
  agent-scoped worker confined to project B reads home-project A's ready rows (title/description/labels).
  Sole outlier; `/tasks`, `/tasks/deps`, `/usage/*`, `/missions` all scope correctly.
- Fix: resolve accessible set; require an accessible `?project_id` or intersect output with `accessibleProjects(c)`.

## LOW

### L1. `POST /users` — no password policy, bypasses schema validation — CONFIRMED
- `src/api/routes/auth.ts:280-289` — no zod schema, no length check; the bootstrap/admin-created user can
  have an empty password. Missing fields → `hashPassword(undefined)` → 500. Fix: `userCreateSchema` via `parseBody`.

### L2. `Number()` on unvalidated params → `NaN` bind → 500 — CONFIRMED (narrow)
- Only **LIMIT-position** binds throw (`datatype mismatch`): `src/api/routes/memory.ts:39`
  (`/memory/events?limit=abc`) and `:228` (`/memory?q=x&limit=abc`). WHERE-position `Number(param)` binds
  match nothing (clean 404/no-op) — not a 500. Fix: route the two `limit` reads through `queryInt`.

### L3. Setup-window SSRF via provider probe / brain test — PLAUSIBLE
- `src/api/routes/brain.ts:282-292` (`/brain/providers/probe`), `:297-307` (`/brain/test`) gate with
  `if (d.users && d.users.count() > 0 && !isAdmin) 403` → open to an unauthenticated caller during setup
  mode (0 users). `providers/probe` fetches attacker-supplied `baseUrl + /models` → SSRF to internal
  services. Narrow window (fresh install, no stored secrets yet). Fix: require genuine admin auth.

### L4. Generated-image dir not per-user — PLAUSIBLE (minor)
- `src/api/routes/brain.ts:192-204` serves shared `image-gen`/`image-edit` dirs to any full-scope user;
  filenames are unguessable random hashes (traversal-safe), so exposure needs the name. Low.

## New (from the bug pass, security-relevant)

### N1. Advisor/worker token enters tmux pane scrollback via the legacy spawn path — Low/Medium, CONFIRMED
- `src/spawn/spawn.ts:53,70` + `src/spawn/commandBuilder.ts:102-105` inline `export ELOWEN_TOKEN='…'` into
  the shell command string delivered by `send-keys` → sits in scrollback, readable via `capturePane` /
  `GET /sessions/:name/pane`. `spawnArgv` (`driver.ts:14-27`) exists precisely to avoid this but only
  `terminalService.ts:71` uses it; every worker/pilot/overseer/advisor launch uses the legacy path.
- Fix: move `SpawnService.launch` to `spawnArgv` (env via `-e`), or `set-environment` instead of the visible line.

## Checked and SOUND
Middleware order + agent-token confinement (`agentProjects()`, tight verb allow-list, field-scoped
`PATCH /tasks/:id`), tenancy predicates fail-closed, SSE per-subscriber `visible()`, avatar HMAC
(`timingSafeEqual`, exp-bounded), scrypt (N=16384, 16-byte salt, timing-safe), WS ticket (single-use, 30s
TTL, minted post-`sessionAccessible`), tmux/shell (all `execFile` argv, `esc()` escaping, env-key regex,
`allowedExecs` gate), all SQL parameterized, path-traversal guards (`projectFiles.safe`, name regexes),
BFF (HttpOnly+SameSite cookie→Bearer, strict `FORWARD_ALLOW`, CSRF same-origin, 401 clears cookie),
config redaction (`apiKey`→`apiKeySet`, `webPush.privateKey` dropped), login rate-limit (per-IP, nginx
`x-real-ip`). Deployment invariant to keep asserted: daemon binds `127.0.0.1`, nginx sets `X-Real-IP`.
