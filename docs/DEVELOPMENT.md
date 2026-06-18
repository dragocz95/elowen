# Development

## Prerequisites

- **Node.js** ≥22 (ESM)
- **tmux** (for running agents)
- **npm**

## Setup

```bash
git clone <repo> && cd orca
npm install
npm run build
```

## Development workflow

### Run the daemon

```bash
npm run serve
```

Uses `--experimental-strip-types` for direct TS execution. Starts on `http://localhost:4400`.

### Run tests

```bash
npm test            # single run
npm run test:watch  # watch mode
```

Tests use Vitest with fake implementations for tmux, clock, and inference — no external dependencies needed.

### Build

```bash
npm run build
```

Compiles TypeScript to `dist/` and copies `src/store/schema.sql`. The CLI binary is at `dist/cli/index.js`.

### CLI

```bash
node dist/cli/index.js ls
node dist/cli/index.js ready
node dist/cli/index.js sessions
```

Or link globally: `npm link` then `orca ls`.

The CLI auto-starts the daemon if it isn't running (set `ORCA_AUTOSTART=0` to disable).

### Web frontend

```bash
cd web
npm install
npm run dev     # Next.js dev server
npm test        # Vitest
npm run build   # Production build
```

Connects to the daemon at `NEXT_PUBLIC_ORCA_URL` (default `http://localhost:4400`).

---

## Project conventions

### Code style

- **TypeScript** strict mode with `noUncheckedIndexedAccess`
- **ESM** only — no CommonJS
- No `any` types
- No static methods — constructor DI everywhere
- No comments in source code
- No dead code, no debug leftovers

### Architecture

- **Thin controllers** (`src/api/`), business logic in services
- **Constructor dependency injection** — all services receive their deps via constructor
- **Interface-driven** — `TmuxDriver`, `Clock` have real and fake implementations
- **Single source of truth** — no parallel logic or duplicate systems

### Naming

- Files: `camelCase.ts`
- Classes: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- SQL identifiers: `snake_case`

### Testing

- Tests mirror `src/` structure in `tests/`
- Fake implementations in test files (not shared)
- Deterministic time via `FakeClock`
- No real tmux or network calls in tests

---

## Project structure

```
src/
├── api/              Hono REST router + SSE event bus
│   ├── server.ts     Route definitions
│   ├── auth.ts       Bearer token auth middleware
│   └── sse.ts        EventBus implementation
├── cli/              CLI client (ls, ready, sessions)
│   ├── index.ts      Entrypoint with daemon autostart
│   └── client.ts     HTTP client for the daemon API
├── daemon/           Daemon bootstrap
│   ├── index.ts      HTTP server entrypoint
│   ├── bootstrap.ts  DI wiring
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
├── overseer/         Orchestration engine
│   ├── missionEngine.ts  Tick loop, spawn logic
│   ├── guardrails.ts     Regex-based safety checks
│   ├── routing.ts        Task → agent routing
│   ├── scheduler.ts      Scheduled task execution
│   ├── decision.ts       LLM-based prompt decision engine
│   ├── janitor.ts        Zombie session cleanup
│   └── planner.ts        AI goal decomposition
├── shared/           Utilities
│   └── clock.ts      Clock interface (system + fake)
├── spawn/            Agent launcher
│   ├── spawn.ts      SpawnService
│   └── commandBuilder.ts  Agent command construction
├── store/            SQLite data layer
│   ├── db.ts         Database connection
│   ├── schema.sql    Table definitions
│   ├── types.ts      Shared store types (Task, TaskStatus, etc.)
│   ├── taskStore.ts  Task CRUD + dependency tree
│   ├── missionStore.ts  Mission CRUD
│   ├── missionDetail.ts  Composite mission query
│   ├── agentStore.ts    Agent registry
│   ├── readiness.ts     Task readiness computation
│   ├── configStore.ts   Daemon configuration
│   ├── userStore.ts     User management + auth tokens
│   ├── projectStore.ts  Project CRUD
│   └── eventStore.ts    Activity event log
└── tmux/             tmux abstraction
    ├── types.ts      TmuxDriver interface
    ├── driver.ts     RealTmuxDriver
    └── fakeDriver.ts In-memory fake for tests
```

---

## Auth system

Auth is optional. When the server factory receives a `UserStore`, it enables:

- `POST /auth/login` — public endpoint, returns bearer token
- `POST /auth/logout` — revokes current token
- `GET /auth/me` — returns current user
- `GET /users`, `POST /users`, `DELETE /users/:id` — user management
- `authMiddleware` on all other routes (401 if no valid token)

Passwords use scrypt with random salt. Tokens are 32-byte hex strings stored in `auth_tokens` table.

### Adding auth to bootstrap

```typescript
import { UserStore } from '../store/userStore.js';

const users = new UserStore(db);
const app = createServer({ ...deps, users });
```

Without `users`, the server runs without authentication.

## AI planning

The `POST /tasks/plan` endpoint decomposes goals via LLM:

1. Constructs a prompt asking for JSON array of 3–7 phases
2. Sends via the configured autopilot inference client
3. Parses and validates the response
4. Creates epic + sequential tasks with dependencies
5. Optionally engages a mission

The planner is in `src/overseer/planner.ts`. To test:

```typescript
import { parsePhases } from '../src/overseer/planner.js';

const phases = parsePhases('[{"title":"Fix login","type":"bug"}]');
// [{ title: 'Fix login', type: 'bug' }]
```

## Adding a new endpoint

1. Add the handler in `src/api/server.ts`
2. Add the corresponding method in `web/lib/orcaClient.ts`
3. Add the TypeScript types in `web/lib/types.ts` if needed
4. Wire any new service dependencies through `src/daemon/bootstrap.ts`
5. Add tests in `tests/`

## Adding a new guardrail

1. Add the guardrail name to `GUARDRAILS` in `src/overseer/guardrails.ts`
2. Add the regex pattern in `PATTERNS`
3. No other changes needed — guardrails are picked up automatically

---

## TypeScript configuration

### Root (daemon) — `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  }
}
```

### Web — `web/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "paths": { "@/*": ["./*"] },
    "plugins": [{ "name": "next" }]
  }
}
```

---

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `ORCA_URL` | `http://localhost:4400` | Daemon URL for CLI |
| `ORCA_AUTOSTART` | `1` | Enable CLI daemon autostart |
| `NEXT_PUBLIC_ORCA_URL` | `http://localhost:4400` | Daemon URL for web UI |

### Runtime config

Stored in SQLite `settings` table. Managed via `GET/PUT /config` API:

```json
{
  "allowedExecs": ["sonnet", "codex:gpt-5.4"],
  "autopilot": {
    "model": "mimo-v2.5",
    "apiUrl": "https://ai.coresynth.io/v1",
    "apiKey": "sk-..."
  }
}
```

---

## Database

SQLite with WAL mode. Schema in `src/store/schema.sql`.

### Tables

```sql
projects  (id, slug, path)
tasks     (id, project_id, title, type, status, priority, parent_id, labels, created_at)
task_deps (task_id, depends_on_id)
agents    (id, project_id, name, program, model, last_active_ts)
missions  (id, epic_id, autonomy, max_sessions, cleared_guardrails, state, started_at)
settings  (id, data)  -- JSON blob for runtime config
```

DB path defaults to `./orca.db` (configurable via `bootstrap.ts`).

### Extras

The `activity_log` table records all state changes automatically (via event bus → activity store).  
The `settings` table stores daemon configuration as a JSON blob.  
The `auth_tokens` table manages active sessions when auth is enabled.

---

## Guardrails

Tasks are blocked if their title or labels match sensitive patterns:

| Guardrail | Pattern |
|---|---|
| `schema` | `schema` |
| `migration` | `migrat*` |
| `auth` | `auth`, `login`, `password`, `token` |
| `payments` | `payment`, `billing`, `stripe`, `invoice` |
| `destructive` | `delete`, `drop`, `truncate`, `rm -rf`, `destroy` |

Blocked tasks are skipped by the mission engine unless the guardrail is cleared in the mission's `cleared_guardrails`.

---

## Agent routing

Tasks can specify an executor via labels:

- `exec:claude-code` → Claude Code (default)
- `exec:opencode` → OpenCode
- `exec:codex` → Codex CLI
- `exec:sonnet` → Claude with Sonnet model
- `exec:ollama/deepseek-v4-flash` → OpenCode with local model

The resolver is in `src/overseer/routing.ts`. Unrecognized execs fall back to `claude-code`.
