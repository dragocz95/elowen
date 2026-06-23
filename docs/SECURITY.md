# Security

## Authentication

Authentication is optional. When a `UserStore` is configured, the daemon uses bearer token auth:

| Mechanism | Detail |
|---|---|
| Login | `POST /auth/login` — username + password, returns `{ token, user }` |
| Token | 32-byte random hex string, stored in `auth_tokens` table |
| Transport | `Authorization: Bearer <token>` header or `?token=<query>` param (SSE only) |
| Password | scrypt with random 16-byte salt, 64-byte derived key |
| Logout | `POST /auth/logout` — revokes the current token server-side |

### Public endpoints (no auth)

- `GET /health`
- `POST /auth/login`

All other endpoints require a valid bearer token when `UserStore` is configured. Open mode (no `UserStore`, `ORCA_ALLOW_OPEN=1`) skips auth entirely.

### Token scope

Every token carries a `scope` field (column `scope` on `auth_tokens`, aliased to `token_scope` in the join query):

| Scope | Purpose | Restrictions |
|---|---|---|
| `full` | Interactive user session (login via browser/CLI) | Bounded by the user's role and project assignments |
| `agent` | Spawned agent (worker, overseer, pilot) — injected via `ORCA_TOKEN` | Verb + path allow-list; project scope confined to the agent's live working set |
| `advisor` | Per-user assistant session (`orca-advisor-<userId>`) | Mapped to `full` at the guard so it has the user's own rights, but isolated from login tokens so rotating/stopping the advisor never touches `full` tokens |

**Agent-scoped tokens** are injected into every spawned agent via `ORCA_TOKEN` (set by `bootstrap.ts` to `ensureAgentToken()` for the lowest-id user — the FK owner, not the security boundary). They prevent a prompt-injected agent from:

- Creating users or performing admin operations (`/users`, `/config`, project register/delete)
- Accessing projects it isn't actively working in
- Listing tokens, reading other agents' data, or spawning sessions

The `agentAllowed()` gate in `server.ts` runs as middleware **before** any route handler. It admits only the verbs the agent CLI actually drives:

| Verb | Path | Used by |
|---|---|---|
| `GET` | `/tasks`, `/tasks/ready`, `/sessions` | `orca ls` / `orca ready` / `orca sessions` |
| `GET` | `/plan/:jobId` | Pilot poll |
| `GET` | `/missions/:id/overseer/next` | Overseer poll |
| `PATCH` | `/tasks/:id` | `orca close` |
| `POST` | `/plan/:jobId/submit` | `orca plan submit` |
| `POST` | `/missions/:id/overseer/decide` | `orca overseer decide` |

Any other route returns `403` for an `agent`-scoped token. Project ownership of the affected row is still enforced downstream by `canAccessProject`, so the agent cannot cross tenancy even within the allow-list.

### `agentProjects()` — agent project scope

The `agentProjects()` helper in `server.ts` resolves the agent's allowed project set at query time (every request that touches a project row):

- **Workers** → projects with an `in_progress` task carrying an `agent:` label
- **Overseers** → projects of every active mission's epic (the overseer polls even between phases)
- **Final-phase agents** → a still-open epic that hosted agent work keeps its project reachable until the epic is actually closed (covers the epic-close right after the agent's own leaf closes; no permanent widening)
- **Pilot** → only ever submits to the plan job it was handed (project checked on that route), so it needs no entry here

`canAccessProject`, `accessibleProjects`, and `missionAccessible` all consult this set for `agent`-scoped tokens — never the admin bypass.

### Token lifecycle

```
issue → store in auth_tokens → validate on each request → revoke on logout (or expire via TTL)
```

The daemon configuration exposes `security.tokenTtlDays` (default: 30 days). Every token row records its creation timestamp; lookups filter out rows older than the TTL:

```json
{
  "security": { "tokenTtlDays": 30 }
}
```

Expired tokens are purged every hour by the **Token purge** loop (`purgeExpiredTokens` in `UserStore`, wired in `bootstrap.ts`). Tokens created before `now - tokenTtlDays` are deleted from `auth_tokens` and become invalid immediately.

### Agent token rotation

`ensureAgentToken()` (in `UserStore`) is idempotent: at daemon boot it reuses an existing non-expired `agent`-scoped token for the owning user, preserving in-flight agent credentials across restarts. `refreshAgentToken()` provides an explicit rotation primitive (issues a fresh agent token and revokes the old one).

### Login rate limiting

`POST /auth/login` is the only unauthenticated, credential-checking endpoint, so it has a dedicated brute-force guard:

- **Limit:** 10 failed attempts per 5-minute window per client IP
- **IP source:** `x-real-ip` header (set by our nginx) preferred over the client-spoofable `x-forwarded-for`; falls back to `'unknown'`
- **Window:** fixed 5-minute window per IP, stored in an in-process `Map`
- **Memory:** entries self-expire; the map is swept when it grows past 5000 entries so distinct-IP traffic can't leak memory
- **Reset:** a successful login clears the IP's counter (so an earlier typo streak can't lock the user out)
- **Response:** `429 { error: 'too many login attempts, try again later' }` when exceeded

In-process is sufficient for the single-daemon deployment model. The IP is read once per login attempt via `c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'`.

### Web UI

Tokens are stored in `localStorage` under `orca.token`. The `LoginGate` wrapper checks for a stored token on mount and shows the `LoginForm` if absent. SSE endpoints append the token as `?token=<value>` (EventSource limitation — `EventSource` cannot set headers).

Avatar images use short-lived signed URLs (HMAC over `(userId, exp)`, 5-minute TTL) instead of putting the long-lived session token in the query string — see `src/api/server.ts` `signAvatar` / `avatarSigValid`. An `<img>` can't set an `Authorization` header, so the signed URL is minted by an authenticated caller and the URL itself is near-worthless if leaked.

---

## Decision engine (overseer gate)

The `decision.ts` module provides the safety layer for agent permission prompts. When an agent pauses on a gate:

1. The decision engine constructs a prompt for the LLM overseer (relay or parked agent)
2. The LLM decides: approve or escalate to human?
3. `gateVerdict()` applies the centralized `MIN_CONFIDENCE` (0.6) threshold — low-confidence approvals are auto-escalated
4. For L1 autonomy, the stricter `STRICT_CONFIDENCE` threshold applies

### Local destructive heuristic

Before consulting the LLM, `isDestructive(text)` runs a hardcoded regex over `question + context`:

```
rm -rf | DROP TABLE | DELETE FROM | TRUNCATE |
migrat | .env | secret | credential | password |
private_key | force push | git reset --hard |
git push -f | chmod 777 | curl | wget | sh | bash |
python -e | node -e | perl -e | nc | ncat | bash -c |
eval( | os.system | subprocess. | exec(
```

If matched, `destructive` is set to true and the decision is forced to escalate regardless of LLM opinion. The local heuristic is authoritative at enqueue time.

### LLM fallback

If the LLM is unreachable or returns unparseable output, the decision defaults to:

```
{ approve: false, confidence: 0, destructive: <local-heuristic-result>, rationale: 'overseer inference failed' }
```

**Fail closed** — always escalate when uncertain.

### Assistant / MCP server

The per-user assistant (`orca-advisor-<userId>`) runs with a **full-scope** `advisor`-scoped token bound to its user's rights, so it can do anything the user could — but it is isolated from the user's login (`full`) tokens. Rotating or stopping the advisor never invalidates a login session, and vice-versa. The assistant's token is minted by `ensureAdvisorToken()` (idempotent — reused across restarts).

The advisor reaches the daemon through two equivalent authenticated paths, both using `ORCA_TOKEN`:

1. **MCP tools** — the built-in MCP server at `POST /mcp`. Each request is handled statelessly: a fresh `McpServer` + transport bound to the request's bearer token, so every connection acts with exactly its user's rights. The toolset (`orca_request` generic escape hatch + typed helpers) all delegate to the shared `callOrcaApi` core — no request logic is duplicated with the CLI.
2. **`orca api <METHOD> <path> [body]`** — the generic CLI passthrough. Same shared forward core, same bearer token.

The MCP config files written into the advisor's cwd (`.mcp.json` / `opencode.json` / `.codex-mcp.toml`) carry the advisor's bearer token, so they are locked to the daemon user (0600).

### Guardrails (removed in v1.1.1)

The regex-based safety check system was eliminated because it caused missions to stall silently when descriptive phase titles triggered false-positive matches. The `cleared_guardrails` column is no longer selected in any query (a pre-existing DB may still carry it; `missionStore.ts` uses an explicit column list so the drop is forward-compatible). The overseer decision gate is now the sole safety layer for permission prompts.

---

## User management

| Operation | Restriction |
|---|---|
| List users | `GET /users` — any authenticated user (no sensitive data returned) |
| Create user | `POST /users` — admin only (except first user in setup mode, when `users.count() === 0`) |
| Edit user | `PATCH /users/:id` — admin only (toggle `is_admin`, `allowed_execs`, name, email) |
| Delete user | `DELETE /users/:id` — cannot delete last user or the last admin |
| User avatar | `GET /users/:id/avatar` — validated via signed URL HMAC, returns image bytes |

Self-service (any authenticated user, own record only):

| Operation | Endpoint |
|---|---|
| Read profile | `GET /auth/me` |
| Edit name / email / `default_exec` | `PATCH /auth/me` (default_exec must be in global `allowedExecs` and the user's `allowed_execs`) |
| Upload avatar | `POST /auth/me/avatar` (multipart, ≤2 MB, png/jpeg/webp/gif) |

### Multi-tenancy / RBAC

When a `userProjects` store is present (multi-user mode), four access gates apply:

1. **Agent capability gate** — `agent`-scoped tokens confined to the verb allow-list above (403 otherwise)
2. **Global gate** — non-admin users must be assigned to the daemon's home project to access the GATED surface (`/tasks`, `/missions`, `/sessions`, `/activity`, `/events` — boundary-matched so `/tasksfoo` can't sneak past `/tasks`). Setup mode (`users.count() === 0`) bypasses this.
3. **Per-project gate** — `canAccessProject`: users only see/operate projects they're assigned to; admin sees everything. Agent-scoped tokens use `agentProjects()` (live working set), never the admin bypass.
4. **Per-user exec allowlist** — `allowed_execs` on the user record restricts which exec strings a non-admin may use; empty list = unrestricted (subject to global `allowedExecs`). Enforced at task create/update and at `PATCH /auth/me` default_exec.

Open/single-user mode (no `userProjects` store) — all authenticated users pass everything unrestricted. `notAdmin()` returns false in this mode.

---

## Configuration security

- API keys (autopilot relay) are stored in the SQLite `settings` table as a JSON blob
- `apiKeySet` is exposed in `GET /config` responses (boolean), but the key value is never returned
- Key is write-only via `PUT /config`: sent once, hashed/stored, never read back
- `avatarSecret` is a random 32-byte hex generated at daemon boot (`randomBytes(32)`) — regenerated on each restart, which invalidates all previously signed avatar URLs

### Allowed executors

The `allowedExecs` list controls which AI executors can be spawned via the API:

```json
["sonnet", "codex:gpt-5.4", "ollama/deepseek-v4-flash"]
```

Requesting an unlisted executor returns `400`. Per-user `allowed_execs` can further restrict non-admins (403 if violated). Resolution happens in `src/overseer/routing.ts` via `PROGRAM_PREFIXES` from `src/shared/execs.ts`.

---

## Infrastructure

### tmux isolation

Each agent runs in an isolated tmux session:

- Named `orca-<agentName>` for workers, `orca-overseer-<missionId>` for overseers, `orca-pilot-<jobId>` for pilots
- Created with `new-session -d` (detached, no direct terminal access)
- Killable via API (`DELETE /sessions/:name`) or CLI (`orca sessions` + manual kill)
- Sessions run agents with `--dangerously-skip-permissions`; the agent capability gate (above) is the compensating control

### SQLite

- WAL mode for concurrent read/write
- No network exposure — database is file-local (`ORCA_DB`, default `~/.config/orca/orca.db`)
- Schema uses `CREATE TABLE IF NOT EXISTS` — safe for repeated migration
- In-memory (`:memory:`) used in tests

### CORS

The daemon enables CORS for all origins (`app.use('*', cors())`). In production, restrict this:

```typescript
app.use('*', cors({ origin: 'https://orca.example.com' }));
```

### Overseer watchdog

A parked overseer agent can die mid-mission (TUI crash, OOM, network blip), leaving the mission running unsupervised. The **overseer watchdog** (`reconcileOverseers()`) runs every 60 seconds:

1. Re-parks a fresh overseer for every active mission whose agent session is missing
2. Kills orphan overseer sessions (still running but mission no longer active)

This is a separate loop from the mission engine tick (90 s) — an overseer death is detected and repaired within one minute, independently of the agent's task progress. The watchdog also runs once at startup (`bootstrap.ts`) so no mission starts without its overseer. Inert when `autopilot.overseerExec` is empty (relay handles decisions).

---

## Secrets in code

- API keys and tokens are never logged
- SQL schema has no hardcoded secrets
- `.env` patterns are in `.gitignore`
- `data/` and local config stay gitignored
- No secrets in git history — verify before pushing (see `CLAUDE.md`)