# Testing

## Daemon tests

Located in `tests/`, mirroring `src/` structure. Uses **Vitest**.

```bash
npm test              # single run
npm run test:watch    # watch mode
```

### Test count

~1690 test cases across the daemon test suite.

### Conventions

- Tests mirror `src/` path structure
- Fake implementations in test files (not shared)
- Deterministic time via `FakeClock`
- No real tmux or network calls
- No real filesystem IO (mocked)

### Test structure

```
tests/
├── api/              API route tests
├── cli/              CLI command tests
├── daemon/           Bootstrap tests
├── deriver/          Deriver tests
├── inference/        Inference relay tests
├── overseer/         Mission engine, planner, scheduler tests
├── spawn/            Agent launcher tests
├── store/            SQLite store tests
├── tmux/             Tmux driver tests
├── shared/           Utility tests
└── mcp/              MCP server tests
```

## Web tests

Located in `web/tests/`. Uses **Vitest** + **React Testing Library** + **MSW**
for API mocking.

```bash
cd web
npm test              # single run
```

### Test count

~560 test cases across the web test suite.

### Conventions

- Component tests render with RTL
- API calls mocked via MSW
- User interactions via `@testing-library/user-event`
- No real browser or network

## Adding tests

1. Create test file at `tests/<path>/<name>.test.ts` (mirroring `src/`)
2. Import the module under test
3. Use fake implementations for dependencies
4. Test behavior, not implementation
5. Run `npm test` to verify

### Example

```typescript
import { describe, it, expect } from 'vitest';
import { FakeInference } from '../../src/inference/client.js';

describe('RelayClient', () => {
  it('returns a response', async () => {
    const client = new FakeInference();
    const result = await client.decide('test prompt');
    expect(result.text).toBeDefined();
  });
});
```

## CI pipeline

GitHub Actions runs on every push and PR to `main`:

| Job | Commands |
|-----|----------|
| **Daemon** | `npm ci` → `npm run build` → `npm test` |
| **Web** | `npm ci` → `npm run build` → `npm test` |

Both jobs run in parallel on `ubuntu-latest` with Node 22.
