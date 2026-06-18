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

### Token lifecycle

```
issue → store in auth_tokens → validate on each request → revoke on logout
```

Tokens are never returned after initial issuance. There is no token expiry — revocations are explicit via logout.

### Web UI

Tokens are stored in `localStorage` under `orca.token`. The `LoginGate` wrapper checks for a stored token on mount and shows the `LoginForm` if absent.

---

## Guardrails

Guardrails are regex-based safety checks that block agents from performing sensitive operations without explicit clearance.

### Guardrail patterns

| Guardrail | Pattern | Example trigger |
|---|---|---|
| `schema` | `/\bschema\b/i` | "Update DB schema" |
| `migration` | `/\bmigrat/i` | "Run migration" |
| `auth` | `/\b(auth|login|password|token)\b/i` | "Fix login flow" |
| `payments` | `/\b(payment|billing|stripe|invoice)\b/i` | "Add payment" |
| `destructive` | `/\b(delete|drop|truncate|rm -rf|destroy)\b/i` | "Drop table" |

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
git push -f | chmod 777 | curl | sh | bash
```

If matched, `destructive` is set to true and the decision is forced to escalate regardless of LLM opinion.

### LLM fallback

If the LLM is unreachable or returns unparseable output, the decision defaults to:

```
{ approve: false, confidence: 0, destructive: <local-heuristic-result>, rationale: 'overseer inference failed' }
```

Fail closed — always escalate when uncertain. A local destructive heuristic (`rm -rf`, `DROP TABLE`, `DELETE FROM`, `TRUNCATE`, migration, `.env`, secrets, credentials, passwords, force push, `git reset --hard`, `chmod 777`, piped `curl | sh`) always takes precedence over the LLM, forcing escalation.

---

## User management

| Operation | Restriction |
|---|---|
| Create user | `POST /users` — any authenticated user |
| Delete user | `DELETE /users/:id` — cannot delete the last user |
| List users | `GET /users` — returns all users (no sensitive data) |

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

Requesting an unlisted executor returns 400. This prevents unauthorized model usage.

---

## Infrastructure

### tmux isolation

Each agent runs in an isolated tmux session. Sessions are:

- Named `orca-<agentName>` for clear identification
- Created with `new-session -d` (detached, no direct terminal access)
- Killable via API or CLI

### SQLite

- WAL mode for concurrent read/write
- No network exposure — database is file-local
- Schema includes `CREATE TABLE IF NOT EXISTS` — safe for repeated migration

### CORS

The daemon enables CORS for all origins (`app.use('*', cors())`). In production, restrict this:

```typescript
app.use('*', cors({ origin: 'https://orca.example.com' }));
```

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
