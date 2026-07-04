# Development

## Prerequisites

- **Node.js** ≥22 (ESM)
- **tmux** ≥3.x (for running agents)
- **npm**
- **node-pty** is an **optional dependency** — terminals degrade to snapshot
  mirror when the native addon can't build

## Setup

```bash
git clone https://github.com/dragocz1995/orcasynth.git
cd orcasynth
npm install
npm run build
```

## npm scripts

| Command | What it does |
|---------|--------------|
| `npm run serve` | Run daemon directly from TS (no build) on `:4400` |
| `npm run build` | `tsc` + copy `schema.sql` + copy `prompts/` |
| `npm test` | `vitest run` — daemon test suite (~1690 cases) |
| `npm run test:watch` | `vitest` — watch mode |
| `npm run lint` | ESLint + dependency-cruiser |
| `npm run deadcode` | `knip` — detect unused exports, files, deps |

### CLI (without global link)

```bash
node dist/cli/index.js ls
node dist/cli/index.js chat
node dist/cli/index.js close <taskId>
```

Or `npm link` then `orca ls`.

### Web frontend

```bash
cd web
npm install
npm run dev      # Next.js dev server (turbopack)
npm test         # Vitest (~560 cases)
npm run lint     # ESLint + dependency-cruiser
npm run build    # Production build
npm start        # Production server (default port 3000)
```

Connects to the daemon via the same-origin `/api` BFF proxy.

### CI pipeline

GitHub Actions runs on every push and PR to `main`:

| Job | What it does |
|-----|-------------|
| **Daemon** (~1690 tests) | `npm ci` → `npm run build` → `npm test` |
| **Web** (~560 tests) | `npm ci` → `npm run build` → `npm test` |

Both run in parallel on `ubuntu-latest` with Node 22.

---

## Project conventions

### Code style

- **TypeScript** strict mode with `noUncheckedIndexedAccess`
- **ESM** only — no CommonJS
- No `any` types
- No static methods — constructor DI everywhere
- No comments in source code
- No dead code, no debug leftovers — `npm run deadcode` enforces

### Architecture

- **Thin controllers** (`src/api/`), business logic in services
- **Constructor dependency injection** — services receive deps via constructor
- **Interface-driven** — `TmuxDriver`, `Clock`, `InferenceClient` have real
  and fake implementations
- **Single source of truth** — no parallel logic or duplicate systems

### Naming

- Files: `camelCase.ts`
- Classes: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- SQL identifiers: `snake_case`

### i18n

User-facing strings use `useTranslation()` with CS and EN dictionaries in
`web/lib/i18n/dictionaries/`. Every string must exist in both languages.

### Testing

- Tests mirror `src/` structure in `tests/`
- Fake implementations in test files (not shared)
- Deterministic time via `FakeClock`
- No real tmux or network calls
- Web tests use Vitest + React Testing Library + MSW

### Commits

- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, …)
- No internal references (paths, hostnames, credentials)

---

## Project structure

```
src/
├── api/              Hono REST router + SSE event bus
├── cli/              CLI client (commands + chat)
├── daemon/           Bootstrap, DI wiring, timer loops
├── deriver/          Agent terminal polling (5s)
├── brain/            Brain worker, session registry, platform orchestrator
├── embeddings/       Embedding service + background queue
├── inference/        LLM inference relay
├── advisor/          Brain assistant lifecycle
├── mcp/              Built-in MCP server
├── terminal/         Real-PTY WebSocket streaming
├── integrations/     Hermes, project files, CLI detection
├── git/              Git reader (status, branches, commits)
├── overseer/         Mission engine, routing, planner, scheduler,
│                     stuck detector, janitor, checkout, snapshots
├── plugins/          Plugin loader, policy resolver, registry
├── prompts/          Prompt template system
├── shared/           Utilities, clock, executor metadata, mutex
├── spawn/            Agent launcher + resume strategies
├── store/            SQLite data layer (tasks, missions, users, config, …)
└── tmux/             tmux abstraction (real + fake)
plugins/              Brain plugins (discord, cronjob, skills, files, …)
prompts/              Prompt templates (planner, pilot, overseer, worker, …)
tests/                Daemon test suite (~1690 tests)
web/                  Next.js frontend (~560 tests)
docs/                 Documentation
```

---

## Timer loops

Wired in `src/daemon/bootstrap.ts:startLoops()`:

| Loop | Interval | Purpose |
|------|----------|---------|
| Overseer tick | 90 s | Tick active missions |
| Scheduler | 30 s | Launch due scheduled tasks |
| Janitor | 60 s | Kill zombie tmux sessions |
| Stuck detector | 60 s | Revert dead agent tasks |
| Deriver | 5 s | Poll tmux panes for state |
| Overseer watchdog | 60 s | Re-park missing overseers + liveness sweep |
| Decision sweep | 30 s | Sweep panic/check decisions on paused missions |
| Token purge | 1 h | Delete expired auth tokens |
| Event purge | 1 h | Drop old events (>30 days) |
| Ticket sweep | 60 s | Expired WS ticket cleanup |
| PR feedback | 60 s | Poll PR review comments |
| Embed queue | 30 s | Process background embedding jobs |
| Brain worker watchdog | 60 s | Recover stalled brain chat workers |

---

## Auth system

Auth is optional. When the server factory receives a `UserStore`, it enables:

- `POST /auth/login` — rate-limited (10 / 5 min / IP)
- `POST /auth/logout` — revoke token
- `GET /auth/me`, `PATCH /auth/me` — profile
- `POST /auth/me/password` — change password
- `POST /auth/me/avatar` — upload avatar
- User management: `GET/POST/PATCH/DELETE /users`

Passwords use scrypt with random 16-byte salt. Tokens are 32-byte hex strings.

### Token scopes

- `full` — interactive user sessions
- `agent` — spawned agents (verb-restricted allow-list)
- `advisor` — per-user assistant (mapped to full)

---

## Adding a new endpoint

1. Add handler in `src/api/server.ts`
2. Add method in `web/lib/orcaClient.ts`
3. Add query/mutation hooks in `web/lib/queries.ts` / `web/lib/mutations.ts`
4. Add types in `web/lib/types.ts`
5. Wire dependencies in `src/daemon/bootstrap.ts`
6. Add tests in `tests/` (mirror `src/` path)
7. Add i18n keys in both `cs.ts` and `en.ts`
8. If agent-reachable, add to `agentAllowed()` in `server.ts`

The `orca api` CLI verb and MCP `orca_request` tool both delegate to
`callOrcaApi`, so new endpoints work with zero CLI/MCP edits.
