# Testing

## Running tests

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

## Test structure

Tests mirror the `src/` directory structure:

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
| `TmuxDriver` | `RealTmuxDriver` (tmux CLI) | In-memory session simulation |
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

## Web frontend tests

```bash
cd web
npm test
```

Uses:
- **Vitest** — test runner
- **Testing Library** — React component tests
- **MSW** — API mocking (intercepts fetch)

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

## Continuous Integration

```yaml
# GitHub Actions example
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm test
      - run: cd web && npm ci && npm test
```
