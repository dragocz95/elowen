# Testing

## Running tests

### Daemon tests (~915 cases, 108 files)

```bash
# All tests
npm test

# Watch mode
npm run test:watch

# Specific test file
npx vitest tests/store/taskStore.test.ts

# Coverage
npx vitest --coverage
```

### Web frontend tests (~469 cases, 103 files)

```bash
cd web
npm test
npm run test:watch   # watch mode
```

### Lint + architecture checks

```bash
npm run lint      # ESLint + dependency-cruiser (no-circular, layer boundaries, orphans)
npm run deadcode   # knip — fails on unused exports/files/dependencies
```

## Test structure

Daemon tests mirror the `src/` directory structure:

```
tests/
├── advisor/       per-user assistant lifecycle + MCP config
├── api/           server routes, auth, rate limiter, SSE
├── cli/           CLI commands + client + orca api passthrough
├── daemon/        bootstrap wiring, reasoning agents
├── deriver/       pane polling, shell prompt detection
├── helpers/       shared test fixtures
├── inference/     relay client + fake
├── integrations/  hermes install, project files, CLI detection, usage
├── mcp/           MCP server + toolset
├── overseer/      mission engine, routing, decision gate, planner, pilot, stuck detector
├── shared/        clock, execs, logger, apiClient
├── spawn/         spawn service + command builder
├── store/         task/mission/agent/user/project/event stores
├── terminal/      PTY WS bridge, ticket store, wsHandler
└── tmux/          real + fake driver
```

Web tests mirror `web/`:

```
web/tests/
├── app/                 Next.js route-level tests (incl. pop-out terminal window)
├── components/          React components (ui/, feature modules)
├── lib/                 orcaClient, queries, mutations, hooks, i18n, openTerminalWindow
├── modules/             feature-module tests (tasks, timeline, advisor, etc.)
├── globals.test.ts      global setup sanity
├── smoke.test.tsx       render-the-app smoke test
├── msw.ts               shared MSW handlers
├── setup.ts             vitest setup (Testing Library matchers, etc.)
└── test-utils.tsx       render helpers with providers
```

## Test architecture

### Test for VAPID key handling

The daemon auto-generates a VAPID keypair on first boot (`ensureVapidKeys()` in `src/push/vapid.ts`) and persists it in the config store. Tests in `tests/store/configStore.test.ts` verify the public key is exposed while the private key stays server-side, and `tests/push/pushSender.test.ts` validates the sender is a no-op when VAPID keys are absent.

### No external dependencies

Tests never hit real tmux, real databases (beyond in-memory SQLite), or real LLM APIs. Every external interface has a fake implementation:

| Interface | Real | Fake |
|---|---|---|
| `TmuxDriver` | `RealTmuxDriver` (tmux CLI) | `FakeTmuxDriver` (in-memory session simulation) |
| `Clock` | `SystemClock` (real time) | `FakeClock` (manual time control) |
| `InferenceClient` | `RelayClient` (HTTP relay) | `FakeInference` (predictable responses) |

The `FakeTmuxDriver` lives in `src/tmux/fakeDriver.ts` (shared with production code as the in-process fake) and is exercised by `tests/tmux/` for its own behaviour. Other test files construct fakes inline.

### Dependency injection

All services receive dependencies via constructors, making them trivially testable:

```typescript
// Real usage
const tmux = new RealTmuxDriver();
const engine = new MissionEngine({ tmux, tasks, ... });

// Test usage
const tmux = new FakeTmuxDriver();
const engine = new MissionEngine({ tmux, tasks, ... });
```

### Deterministic time

`FakeClock` replaces `setInterval`/`setTimeout` with manual advancement:

```typescript
const clock = new FakeClock();
const engine = new MissionEngine({ clock, ... });

// Advance time by 90 seconds (one engine tick)
clock.advance(90000);
```

Timer-loop tests use `FakeClock` so the 90 s / 60 s / 30 s / 5 s intervals fire deterministically without real waiting.

### In-memory SQLite

Database tests use `:memory:` SQLite:

```typescript
const db = openDb(':memory:');
const store = new TaskStore(db);
```

No temporary files, fast setup/teardown. Schema is applied from `src/store/schema.sql` in test helpers.

### MSW (web)

Web tests use [MSW](https://mswjs.io/) to intercept `fetch` calls to the daemon API. Shared handlers live in `web/tests/msw.ts`; per-test overrides are applied via `renderWithProviders()` from `web/tests/test-utils.tsx`, which wires React Query + i18n + router providers.

## Writing tests

### Pattern

```typescript
import { describe, it, expect } from 'vitest';
import { MyService } from '../src/services/myService.js';

describe('MyService', () => {
  it('does the thing', () => {
    const service = new MyService(/* fakes */);
    const result = service.doSomething();
    expect(result).toBe('expected');
  });
});
```

### What to test

- **Business logic** — task readiness, mission tick decisions, routing resolution
- **Edge cases** — empty state, cycles in DAG, all tasks closed, last-user/admin deletion
- **State transitions** — task lifecycle, mission lifecycle, agent token scope
- **Auth gates** — agent-scope 403 on admin routes, project access, rate limiter
- **Error handling** — daemon unreachable, missing data, corrupt config, malformed JSON

### What not to test

- tmux CLI interactions (tested via `FakeTmuxDriver`)
- SQLite internals (tested via `better-sqlite3` itself)
- Network calls (abstracted behind fakes)

## CI pipeline

GitHub Actions runs on every push and PR to `main` (see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)):

| Job | Commands | Notes |
|-----|----------|-------|
| **Daemon** (~915 tests) | `npm ci` → `npm run build` → `npm test` | tmux installed via `apt` for the real driver test |
| **Web** (~469 tests) | `npm ci` → `npm run build` → `npm test` | runs in `web/` subdirectory |

Both jobs run in parallel on `ubuntu-latest` with Node 22. Superseded runs on the same ref are cancelled automatically.