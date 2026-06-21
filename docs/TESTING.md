# Testing

## Running tests

### Daemon tests (~395 cases)

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

### Web frontend tests (~270 cases)

```bash
cd web
npm test
npm run test:watch   # watch mode
```

Uses:
- **Vitest** — test runner
- **Testing Library** — React component tests
- **MSW** — API mocking (intercepts fetch)

## Test structure

Daemon tests mirror the `src/` directory structure:

```
tests/
├── api/
├── cli/
├── daemon/
├── deriver/
├── inference/
├── overseer/
├── shared/
├── spawn/
├── store/
└── tmux/
```

## Test architecture

### No external dependencies

Tests never hit real tmux, real databases (beyond in-memory SQLite), or real LLM APIs. Every external interface has a fake implementation:

| Interface | Real | Fake |
|---|---|---|
| `TmuxDriver` | `RealTmuxDriver` (tmux CLI) | `FakeTmuxDriver` (in-memory session simulation) |
| `Clock` | `SystemClock` (real time) | `FakeClock` (manual time control) |
| `InferenceClient` | `RelayClient` (HTTP relay) | `FakeInference` (predictable responses) |

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

### In-memory SQLite

Database tests use `:memory:` SQLite:

```typescript
const db = openDb(':memory:');
const store = new TaskStore(db);
```

No temporary files, fast setup/teardown.

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

- **Business logic** — guardrail detection, task readiness, mission tick decisions
- **Edge cases** — empty state, cycles in DAG, all tasks closed, guardrail boundary matches
- **State transitions** — task lifecycle, mission lifecycle
- **Error handling** — daemon unreachable, missing data, corrupt config

### What not to test

- tmux CLI interactions (tested via `FakeTmuxDriver`)
- SQLite internals (tested via `better-sqlite3` itself)
- Network calls (abstracted behind fakes)
