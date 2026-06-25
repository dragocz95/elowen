# Development

## Prerequisites

- **Node.js** ≥22 (ESM)
- **tmux** ≥3.x (for running agents)
- **npm**
- **node-pty** is an **optional dependency** powering the real-PTY terminal stream. Its native addon
  needs a C toolchain (`python3`, `make`, `g++`) to build when no prebuilt binary matches. If it can't
  install, the terminals degrade to the snapshot mirror — everything else still works. `orca install`
  provisions the toolchain and node-pty automatically (best-effort).

## Setup

```bash
git clone <repo> && cd orca
npm install
npm run build
```

## npm scripts

| Command | What it does |
|---|---|
| `npm run serve` | Run the daemon directly from TS via `--experimental-strip-types` (no build step). Starts on `http://localhost:4400`. |
| `npm run build` | `tsc -p tsconfig.json` + copy `src/store/schema.sql` → `dist/store/` + copy `prompts/` → `dist/prompts/`. CLI ends up at `dist/cli/index.js`, daemon at `dist/daemon/index.js`. |
| `npm test` | `vitest run` — single run of the daemon test suite (~823 cases) |
| `npm run test:watch` | `vitest` — watch mode |
| `npm run lint` | ESLint + dependency-cruiser architecture checks (no-circular, layer boundaries, orphans) |
| `npm run deadcode` | `knip` — detect unused exports, files, and dependencies |

### CLI (without global link)

```bash
node dist/cli/index.js ls
node dist/cli/index.js ready
node dist/cli/index.js sessions
node dist/cli/index.js close <taskId> --summary "..." --outcome ok
node dist/cli/index.js plan submit --phases '[...]'
node dist/cli/index.js overseer
```

Or link globally: `npm link` then `orca ls`. The CLI auto-starts the daemon if it isn't running (set `ORCA_AUTOSTART=0` to disable).

### Web frontend

```bash
cd web
npm install
npm run dev      # Next.js dev server (turbopack)
npm test         # Vitest (~433 cases)
npm run lint     # ESLint + dependency-cruiser architecture checks
npm run build    # Production build (copies Monaco workers, then next build)
npm start        # Production server (default port 3000)
```

Connects to the daemon via the same-origin `/api` BFF proxy (see [WEB.md](WEB.md#auth)). Set `ORCA_DAEMON_URL` (server-side, default `http://localhost:4400`) if the daemon is not on localhost — there is no browser-side env var. `NEXT_PUBLIC_ORCA_URL` does **not exist** and is **not supported** — all communication uses the server-side BFF proxy with an httpOnly cookie.

**Gotcha:** a stale turbopack dev server on :4500 serves broken CSS chunks. Fix by killing the :4500 pid and running `next start` (not `next dev`).

### CI pipeline

GitHub Actions runs on every push and PR to `main` (see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)):

| Job | Steps |
|-----|-------|
| **Daemon** (823 tests) | `npm ci` → `npm run build` → `npm test` (tmux installed via apt) |
| **Web** (433 tests) | `npm ci` → `npm run build` → `npm test` (in `web/`) |

Both jobs run in parallel on `ubuntu-latest` with Node 22. Superseded runs on the same ref are cancelled automatically.

---

## Project conventions

### Code style

- **TypeScript** strict mode with `noUncheckedIndexedAccess`
- **ESM** only — no CommonJS
- No `any` types
- No static methods — constructor DI everywhere
- No comments in source code (rationale lives in commit messages and docs)
- No dead code, no debug leftovers — `npm run deadcode` (knip) enforces this

### Architecture

- **Thin controllers** (`src/api/`), business logic in services
- **Constructor dependency injection** — all services receive their deps via constructor
- **Interface-driven** — `TmuxDriver`, `Clock`, `InferenceClient` have real and fake implementations
- **Single source of truth** — no parallel logic or duplicate systems

### Naming

- Files: `camelCase.ts`
- Classes: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- SQL identifiers: `snake_case`

### i18n (Internationalization)

User-facing strings in the web UI use the `useTranslation()` hook with CS and EN dictionaries:

- Dictionary files in `web/lib/i18n/dictionaries/` — edit `cs.ts` and `en.ts` in parallel
- Every user-facing string must exist in BOTH languages
- The `LanguageProvider` context reads the locale from `localStorage` and provides `t` (translations) + `setLocale`
- New keys should be added under the appropriate namespace (nav, tasks, missions, etc.) in both dictionaries

### Testing

- Tests mirror `src/` structure in `tests/`
- Fake implementations in test files (not shared)
- Deterministic time via `FakeClock`
- No real tmux or network calls in tests
- Web tests in `web/tests/` use Vitest + React Testing Library + MSW

See [TESTING.md](TESTING.md) for full details.

### Commits — public repo

This repository is **public** (see `CLAUDE.md`). Commits MUST stay clean:

- Conventional Commits style (`feat:`, `fix:`, `docs:`, `chore:` …)
- No `Claude-Session:` trailer, no `Co-Authored-By: Claude` trailer
- No internal references (paths like `/var/www`, internal hostnames, credentials, DB dumps, planning/superpowers docs)
- Verify no secrets, `.env`, or `data/` files are staged before pushing

---

## Project structure

```
src/
├── api/              Hono REST router + SSE event bus
│   ├── server.ts     Route definitions, auth middleware, rate limiter
│   ├── auth.ts       Bearer token auth middleware
│   └── sse.ts        EventBus implementation
├── cli/              CLI client
│   ├── index.ts      Entrypoint with daemon autostart + commands
│   └── client.ts     HTTP client for the daemon API
├── daemon/           Daemon bootstrap
│   ├── index.ts      HTTP server entrypoint
│   ├── bootstrap.ts  DI wiring + timer loops
│   └── uniqueName.ts Agent name generation
├── deriver/          Agent terminal monitoring
│   ├── deriver.ts    5s poll loop, state detection
│   ├── shellPatterns.ts  Prompt detection per program
│   └── types.ts      Signal types
├── git/              Git integration
│   └── gitReader.ts  Read git status, branches, commits
├── inference/        LLM inference relay
│   ├── client.ts     RelayClient + FakeInference
│   └── types.ts      Inference types
├── advisor/          Per-user Assistant lifecycle
│   ├── service.ts    AdvisorService (start/stop/status/ensureOnLogin)
│   └── mcpConfig.ts  Per-program MCP config writer (.mcp.json / opencode.json / .codex-mcp.toml)
├── mcp/              Built-in MCP server (/mcp endpoint)
│   ├── server.ts     Stateless per-request McpServer + transport, bound to caller's token
│   └── tools.ts      Orca toolset over the shared callOrcaApi core
├── terminal/         Real-PTY terminal streaming over WebSocket
│   ├── ticketStore.ts  Single-use WS tickets
│   ├── ptyLoader.ts    Lazy node-pty import (optional dependency)
│   ├── ptySession.ts   tmux attach PTY client
│   ├── bridge.ts       Full-duplex PTY↔WS logic
│   └── wsHandler.ts     @hono/node-ws upgrade handler
├── integrations/     External integrations
│   ├── hermesInstall.ts  Hermes MCP-server registration
│   ├── projectFiles.ts   File tree, read/write/diff for Monaco editor
│   ├── cliDetection.ts   CLI detection for onboarding
│   └── usage/            Token/cost reader per executor CLI
├── overseer/         Orchestration engine
│   ├── missionEngine.ts  Tick loop, spawn logic
│   ├── routing.ts        Task → agent routing
│   ├── scheduler.ts      Scheduled task execution
│   ├── decision.ts       LLM-based prompt decision engine + gateVerdict
│   ├── decisionQueue.ts  Per-mission FIFO of awaitable decisions
│   ├── janitor.ts        Zombie session cleanup
│   ├── planner.ts        AI goal decomposition
│   ├── planJob.ts        Async planning job registry
│   ├── pilotAgent.ts     Pilot agent spawn logic
│   ├── overseerAgent.ts  Parked overseer agent lifecycle
│   ├── stuckDetector.ts  Stuck task detection + relaunch
│   ├── llmParse.ts       Shared LLM JSON extraction helper
│   └── sessionInfo.ts    Session classification (agent/pilot/overseer)
├── prompts/          Prompt template system
│   └── index.ts      render(name, vars) + rawTemplate(name)
├── shared/           Utilities
│   ├── clock.ts      Clock interface (system + fake)
│   ├── execs.ts      Executor metadata (PROGRAM_PREFIXES, KNOWN_EXECS, etc.)
│   └── logger.ts     File logger (ORCA_LOG_LEVEL / ORCA_LOG_DIR)
├── spawn/            Agent launcher
│   ├── spawn.ts      SpawnService
│   └── commandBuilder.ts  Agent command construction
├── store/            SQLite data layer
│   ├── db.ts         Database connection
│   ├── schema.sql    Table definitions
│   ├── types.ts      Shared store types
│   ├── taskStore.ts  Task CRUD + dependency tree
│   ├── missionStore.ts  Mission CRUD
│   ├── missionDetail.ts  Composite mission query
│   ├── agentStore.ts    Agent registry
│   ├── readiness.ts     Task readiness computation
│   ├── configStore.ts   Daemon configuration
│   ├── userStore.ts     User management + auth tokens
│   ├── userProjectStore.ts  User ↔ project assignments
│   ├── projectStore.ts  Project CRUD
│   └── eventStore.ts    Activity event log
└── tmux/             tmux abstraction
    ├── types.ts      TmuxDriver interface
    ├── driver.ts     RealTmuxDriver
    └── fakeDriver.ts In-memory fake for tests
prompts/              Prompt templates (planner, pilot, overseer, advisor, worker, decision)
tests/                Mirrors src/ structure (~823 tests)
web/                  Next.js frontend (~433 tests)
docs/                 Documentation tree
```

---

## Timer loops

Much of the daemon's orchestration runs on periodic intervals. Wired in
`src/daemon/bootstrap.ts:startLoops()`:

| Loop | Interval | Purpose |
|---|---|---|
| Overseer (engine tick) | 90 s | Tick active missions: pick ready tasks, spawn agents |
| Scheduler | 30 s | Launch due scheduled/autostart tasks |
| Janitor | 60 s | Kill zombie tmux sessions whose task is already closed/cancelled |
| Stuck detector | 60 s | Revert tasks whose agent died without `orca close` (bounded, escalate after 2 relaunch attempts) |
| Deriver | 5 s | Poll tmux panes, detect agent state, auto-approve known prompts via overseer gate |
| Overseer watchdog | 60 s | Re-park missing overseer agents for active/stalled missions (crash recovery) |
| Token purge | 1 h | Delete expired auth tokens (TTL from `config.security.tokenTtlDays`) |
| Event purge | 1 h | Drop `events` rows past the 30-day retention window (`eventStore.purgeOlderThan()`) |
| Ticket sweep | 60 s | Sweep expired terminal-WS single-use tickets |
| PR feedback | 60 s | Poll open PRs for fresh actionable review feedback, re-engage mission with fix phases |

---

## Auth system

Auth is optional. When the server factory receives a `UserStore`, it enables:

- `POST /auth/login` — public endpoint, returns bearer token (rate-limited: 10 / 5 min / IP)
- `POST /auth/logout` — revokes current token
- `GET /auth/me` — returns current user
- `PATCH /auth/me` — update profile (name, email, default_exec)
- `POST /auth/me/avatar` — upload avatar image
- `GET /users`, `POST /users`, `PATCH /users/:id`, `DELETE /users/:id` — user management
- `authMiddleware` on all other routes (401 if no valid token)

Passwords use scrypt with random 16-byte salt. Tokens are 32-byte hex strings stored in `auth_tokens` table, with a `scope` of `full` (interactive) or `agent` (spawned agent, verb-restricted). See [SECURITY.md](SECURITY.md) for the full model.

### Multi-tenancy / RBAC

With a `userProjects` store present (multi-user mode), access is gated four ways:

1. **Agent capability gate** — `agent`-scoped tokens confined to a verb allow-list
2. **Global gate** — non-admin users must be assigned to the daemon's home project to access task/mission/session/activity/event routes
3. **Per-project gate** — users only see/operate projects they're assigned to
4. **Per-user exec allowlist** — `allowed_execs` restricts which exec strings a non-admin may use

Admins and open/single-user mode (no `userProjects`) pass everything unrestricted.

---

## AI planning (autopilot)

The `POST /tasks/plan` endpoint supports two backends:

### Relay backend (default)

1. **Prompt construction** — `planPrompt(goal, guidance)` builds a system prompt
2. **LLM call** — sends via `RelayClient` using `config.autopilot.model`
3. **Parse** — `parsePhases(text)` extracts JSON array, validates each phase
4. **Task creation** — creates epic + chained child tasks with sequential deps
5. **Optional engage** — if `engage: true`, creates and starts a mission

### Agent backend (Pilot)

When `config.autopilot.pilotExec` is set, spawns a **Pilot** agent in the repo. The Pilot reads the codebase and submits phases via `orca plan submit`. No API key needed for planning.

### Manual mode

Pass `phases: [{title, type?}]` — no LLM, no key needed. Synchronous 201 response.

---

## Adding a new endpoint

1. Add the handler in `src/api/server.ts`
2. Add the corresponding method in `web/lib/orcaClient.ts`
3. Add query/mutation hooks in `web/lib/queries.ts` / `web/lib/mutations.ts`
4. Add TypeScript types in `web/lib/types.ts` if needed
5. Wire any new service dependencies through `src/daemon/bootstrap.ts`
6. Add tests in `tests/` (mirror the `src/` path)
7. If the endpoint is user-facing, add i18n keys in both `web/lib/i18n/dictionaries/cs.ts` and `en.ts`
8. If the endpoint should be reachable by spawned agents, add it to the `agentAllowed()` allow-list in `server.ts`
9. The `orca api <METHOD> <path>` CLI verb and the MCP `orca_request` tool both delegate to the shared `callOrcaApi` core, so a new endpoint is reachable from the assistant and any agent with **zero CLI/MCP edits** — only add a typed helper to `src/mcp/tools.ts` if you want a nicer-named tool for it.

---

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `ORCA_URL` | `http://localhost:4400` | Daemon URL for CLI |
| `ORCA_TOKEN` | — | API token for CLI requests |
| `ORCA_AUTOSTART` | `1` | Enable CLI daemon autostart |
| `ORCA_DB` | `~/.config/orca/orca.db` | SQLite database path |
| `ORCA_PORT` | `4400` | Daemon HTTP port |
| `ORCA_HOST` | `127.0.0.1` | Daemon bind address (`0.0.0.0` to expose externally) |
| `ORCA_PROJECT` | `orca` | Default project slug |
| `ORCA_PROJECT_PATH` | `cwd` | Default project working directory |
| `ORCA_RELAY_URL` | — | LLM relay base URL |
| `ORCA_RELAY_KEY` | — | LLM relay API key |
| `ORCA_RELAY_MODEL` | `gpt-4o-mini` | LLM relay model |
| `ORCA_BOOTSTRAP_USER` | — | Initial admin username |
| `ORCA_BOOTSTRAP_PASS` | — | Initial admin password |
| `ORCA_ALLOW_OPEN` | — | Allow open (no auth) mode when set to `1` |
| `ORCA_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `ORCA_LOG_DIR` | `cwd/logs` | Log directory |
| `ORCA_DAEMON_URL` | `http://localhost:4400` | Daemon URL for the web BFF proxy (server-side only) |

### Runtime config

Stored in SQLite `settings` table. Managed via `GET/PUT /config` API:

```json
{
  "allowedExecs": ["sonnet", "codex:gpt-5.4", "ollama/deepseek-v4-flash"],
  "customModels": [],
  "hiddenPresets": [],
  "defaults": { "exec": "sonnet", "autonomy": "L3", "maxSessions": 1 },
  "autopilot": {
    "model": "gpt-4o-mini",
    "overseerModel": "",
    "pilotExec": "",
    "overseerExec": "",
    "reviewOnDone": false,
    "apiUrl": "https://api.openai.com/v1",
    "apiKeySet": false,
    "notes": "",
    "prompt": "Decompose the following goal into ordered implementation phases..."
  },
  "security": { "tokenTtlDays": 30 },
  "providers": {
    "claude-code": { "bin": "claude", "args": "" },
    "opencode": { "bin": "opencode", "args": "" },
    "codex": { "bin": "codex", "args": "" }
  }
}
```

API keys are write-only — `apiKeySet` (boolean) is exposed in `GET /config`, the key value is never returned.

---

## Database

SQLite with WAL mode. Schema in `src/store/schema.sql`.

### Tables

```sql
projects  (id, slug, path, notes)
tasks     (id, project_id, title, type, status, priority, parent_id, labels, description, scheduled_at, autostart, result_summary, outcome, closed_at, created_at)
task_deps (task_id, depends_on_id)
agents    (id, project_id, name, program, model, last_active_ts)
missions  (id, epic_id, autonomy, max_sessions, state, started_at)
settings  (id, data)  -- JSON blob for runtime config
users     (id, username, password_hash, is_admin, allowed_execs, name, email, default_exec, avatar, created_at)
auth_tokens (token, user_id, scope, created_at)
events    (id, ts, type, target, detail)
user_projects (user_id, project_id)
```

---

## Agent routing

Tasks specify executors via labels (`exec:<spec>`). Resolution (`src/overseer/routing.ts`, importing executor metadata from `src/shared/execs.ts`):

- `exec:sonnet` → `{ program: 'claude-code', model: 'sonnet' }`
- `exec:opencode:<model>` → `{ program: 'opencode', model: '<model>' }`
- `exec:codex:<model>` → `{ program: 'codex', model: '<model>' }`
- `exec:claude:<model>` → `{ program: 'claude-code', model: '<model>' }`
- Value contains `/` (e.g. `ollama/deepseek-v4-flash`) → `{ program: 'opencode', model: value }`
- No label → configured fallback (default: `claude-code` / `sonnet`)

Every exec must be in `config.allowedExecs` or the API rejects it.