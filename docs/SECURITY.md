# Security

## Authentication

Authentication is optional. When enabled, the daemon uses bearer token auth:

| Mechanism | Detail |
|---|---|
| Login | `POST /auth/login` — username + password, returns token |
| Token | 32-byte random hex string, stored in `auth_tokens` table |
| Transport | `Authorization: Bearer <token>` header or `?token=<query>` param |
| Password | scrypt with random 16-byte salt, 64-byte derived key |
| Logout | Revokes token server-side |

### Public endpoints (no auth)

- `GET /health`
- `POST /auth/login`

All other endpoints require authentication when `UserStore` is configured.

### Token scope

Tokens carry a `scope` field with two values:

| Scope | Purpose | Restrictions |
|---|---|---|
| `full` | Interactive user session (login via browser/CLI) | Full access according to the user's role and project assignments |
| `agent` | Spawned agent (worker, overseer, pilot) | Confined to task-close/plan-submit/overseer-decide verbs; project scope limited to the agent's live working set |

**Agent-scoped tokens** are injected into every spawned agent via `ORCA_TOKEN`. They prevent a compromised agent from:
- Creating users or admin operations
- Accessing projects it isn't actively working in
- Listing tokens or reading other agents' data

The `agentProjects()` helper in `server.ts` resolves the agent's allowed project set at query time: workers may touch projects with an `in_progress` agent-labelled task, overseers may touch projects of every active mission's epic. The `agent` scope gate runs as a middleware — non-agent routes return 403 for agent-scoped tokens.

Tokens are re-issued via `ensureAgentToken()` at daemon boot, preserving existing in-flight agent credentials across restarts. `refreshAgentToken()` provides an explicit rotation primitive.

### Token lifecycle

```
issue → store in auth_tokens → validate on each request → revoke on logout
```

The daemon configuration exposes `security.tokenTtlDays` (default: 30 days). Every token row records its creation timestamp; lookups filter out rows older than the TTL:

```json
{
  "security": { "tokenTtlDays": 30 }
}
```

Expired tokens are purged every hour by the **Token purge** loop (`purgeExpiredTokens` in `UserStore`). Tokens created before `now - tokenTtlDays` are deleted from `auth_tokens` and become invalid immediately.

### Web UI

Tokens are stored in `localStorage` under `orca.token`. The `LoginGate` wrapper checks for a stored token on mount and shows the `LoginForm` if absent. SSE endpoints append the token as `?token=<value>` (EventSource limitation).

---

## Guardrails

Guardrails are regex-based safety checks that block agents from performing sensitive operations without explicit clearance.

### Guardrail patterns

| Guardrail | Pattern | Example trigger |
|---|---|---|
| `schema` | `/\bschema\b/i` | "Update DB schema" |
| `migration` | `/\bmigrat/i` | "Run migration" |
| `auth` | `/\b(auth\|login\|password\|token)\b/i` | "Fix login flow" |
| `payments` | `/\b(payment\|billing\|stripe\|invoice)\b/i` | "Add payment" |
| `destructive` | `/\b(delete\|drop\|truncate\|rm -rf\|destroy)\b/i` | "Drop table" |

### Enforcement

Guardrails are checked in the mission engine tick:

1. Task title + labels are scanned against all guardrail patterns
2. If any pattern matches, the guardrail is **triggered**
3. The task is skipped unless:
   - Mission autonomy is L2 or L3
   - AND the triggered guardrail is in the mission's `cleared_guardrails`

### Clearance

Guardrails are cleared per-mission. The operator decides which guardrails to clear when engaging a mission:

```json
{
  "epicId": "epic-1",
  "autonomy": "L3",
  "clearedGuardrails": ["schema", "migration"]
}
```

This allows schema changes but blocks payments and destructive operations.

### Overseer gate

When an **overseer LLM gate** is configured, a second opinion is consulted for guardrail-triggering tasks before dispatch. A denial or destructive verdict escalates the task to `blocked`. This can run via a relay model or a parked Overseer agent.

---

## Decision engine

The `decision.ts` module provides a secondary safety layer for agent prompts. When enabled:

1. Agent pauses on a permission gate
2. The decision engine constructs a prompt for the LLM overseer
3. The LLM decides: approve or escalate to human?

### Local destructive heuristic

Before consulting the LLM, a hardcoded regex checks for clearly destructive operations:

```
rm -rf | DROP TABLE | DELETE FROM | TRUNCATE |
migrat | .env | secret | credential | password |
private_key | force push | git reset --hard |
git push -f | chmod 777 | curl | wget | sh | bash |
python -e | node -e | perl -e | nc | ncat | bash -c |
eval( | os.system | subprocess. | exec(
```

If matched, `destructive` is set to true and the decision is forced to escalate regardless of LLM opinion.

All decisions pass through the centralized `gateVerdict()` function in `decision.ts`, which applies the `MIN_CONFIDENCE` threshold (0.6) as a single source of truth — low-confidence approvals are automatically escalated.

### LLM fallback

If the LLM is unreachable or returns unparseable output, the decision defaults to:

```
{ approve: false, confidence: 0, destructive: <local-heuristic-result>, rationale: 'overseer inference failed' }
```

Fail closed — always escalate when uncertain.

---

## User management

| Operation | Restriction |
|---|---|
| List users | `GET /users` — any authenticated user (no sensitive data) |
| Create user | `POST /users` — admin only (except first user in setup mode) |
| Edit user | `PATCH /users/:id` — admin only (toggle is_admin, allowed_execs) |
| Delete user | `DELETE /users/:id` — cannot delete last user or admin |
| User avatar | `GET /users/:id/avatar` — auth token as query param, returns image bytes |

### Multi-tenancy / RBAC

When `userProjects` store is present, three access gates apply:

1. **Global gate** — non-admin users must be assigned to daemon's home project to access task/mission/session/activity surface (403 otherwise)
2. **Per-project gate** — users only see/operate projects they're assigned to; admin sees everything
3. **Per-user exec allowlist** — `allowed_execs` on the user record restricts which exec strings a non-admin may use; empty list = unrestricted (subject to global `allowedExecs`)

Open/single-user mode (no `userProjects`) — all authenticated users pass everything unrestricted.

---

## Configuration security

- API keys (autopilot) are stored in SQLite `settings` table
- `apiKeySet` is exposed in config responses (boolean), but never the key value
- Key is write-only via `PUT /config`: sent once, never returned

### Allowed executors

The `allowedExecs` list controls which AI executors can be spawned via the API:

```json
["sonnet", "codex:gpt-5.4", "ollama/deepseek-v4-flash"]
```

Requesting an unlisted executor returns 400. Per-user `allowed_execs` can further restrict non-admins (403 if violated).

---

## Infrastructure

### tmux isolation

Each agent runs in an isolated tmux session. Sessions are:

- Named `orca-<agentName>` for clear identification
- Created with `new-session -d` (detached, no direct terminal access)
- Killable via API or CLI
- Reasoning agents use reserved naming: `orca-overseer-<missionId>`

### SQLite

- WAL mode for concurrent read/write
- No network exposure — database is file-local
- Schema includes `CREATE TABLE IF NOT EXISTS` — safe for repeated migration

### CORS

The daemon enables CORS for all origins (`app.use('*', cors())`). In production, restrict this:

```typescript
app.use('*', cors({ origin: 'https://orca.example.com' }));
```

### Overseer watchdog

A parked overseer agent can die mid-mission (TUI crash, OOM, network blip), leaving the mission running unsupervised. The **overseer watchdog** (`reconcileOverseers()`) runs every 60 seconds:

1. Re-parks a fresh overseer for every active mission whose agent session is missing
2. Kills orphan overseer sessions (still running but mission no longer active)

This is a separate loop from the mission engine tick (90s) — an overseer death is detected and repaired within one minute, independently of the agent's task progress. The watchdog also runs once at startup (`bootstrap.ts`) so no mission starts without its overseer.

### Rate limiting

Not currently implemented. Recommended for production:

- `POST /auth/login` — brute force protection
- `POST /tasks/plan` — prevent excessive LLM calls
- `POST /sessions` — limit spawn rate

---

## Secrets in code

- API keys and tokens are never logged
- SQL schema has no hardcoded secrets
- `.env` patterns are in `.gitignore`
- No secrets in git history
