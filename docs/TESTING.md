# Testing

Elowen has separate daemon and web dependency roots, plus tests that boot the built daemon, the standalone web server, or a packaged install. Install both dependency trees before running cross-stack checks.

```bash
npm ci
npm ci --prefix web
```

Node.js 22 is the CI baseline. Install `tmux` for real-daemon, CLI/TUI, and terminal coverage. Some plugin and CI paths also require `poppler-utils`, `ripgrep`, and `bubblewrap`; the CI jobs install those explicitly. `node-pty` is optional and tests should cover the documented snapshot/SSE fallback when native PTY support is unavailable.

## Daemon tests

Daemon tests live in `tests/` and are run by the root Vitest configuration. They cover the API, brain/session lifecycle, providers, stores and migrations, CLI/TUI, plugins, MCP, sub-agents, terminal transport, and cross-stack contracts.

```bash
npm test
npm run test:watch
```

Run a focused file or directory while iterating:

```bash
npx vitest run tests/api/brainRoutes.test.ts
npx vitest run tests/store
npx vitest run tests/subagent
npx vitest run tests/cli
```

Use isolated temporary databases and project directories for store and integration tests. Use fake clocks and controlled fake providers, tmux drivers, transports, or model servers instead of live external systems. Add regression coverage at the route, service, store, or CLI boundary where the defect occurs.

`tests/contract/` contains cross-boundary conformance checks. These tests protect mirrored daemon/web contracts, plugin API and shared-package contracts, language coverage, build dependencies, and other invariants that ordinary unit tests cannot see.

## Web tests

Web unit and component tests live in `web/tests/` and use Vitest, React Testing Library, user-event, and MSW.

```bash
npm --prefix web test
npm --prefix web run test:watch
```

Mock daemon calls with the shared MSW setup. Test React Query loading, error, mutation, optimistic-update, and invalidation behavior rather than only the initial render. For UI changes, cover the actual keyboard/pointer interaction, focus behavior, responsive state, and Czech/English copy where relevant.

## Browser E2E

The Playwright suite is under `web/tests/e2e/` and matches `*.e2e.ts`. It runs the real Next.js development server against a scriptable fake Hono daemon. This preserves the real cookie, BFF proxy, EventSource, login, and transcript paths while replacing only nondeterministic brain behavior.

The configured projects cover both authenticated and unauthenticated browser sessions. The harness uses throwaway ports, serial workers, and a fake daemon health endpoint.

```bash
npm --prefix web run e2e        # full browser suite
npm --prefix web run e2e:smoke  # @smoke subset
```

Use page objects and fixtures in `web/tests/e2e/` rather than duplicating selectors. Add non-behavioral `data-testid` hooks when a stable selector is needed. Playwright artifacts and authenticated storage state are local test output and must not be committed.

The built cross-stack browser job is also available from the repository root:

```bash
npm run test:e2e:web
```

That command builds `dist/` and `web-dist/`, then runs `scripts/tests/web-e2e/run.mjs` against the real built daemon and web server.

## Real-daemon E2E

These scripts build the daemon before starting it and use throwaway ports, databases, and scripted model servers:

```bash
npm run test:e2e:brain          # HTTP/SSE chat turn and provider error path
npm run test:e2e:stop-kill      # stop and kill lifecycle
npm run test:e2e:api            # REST, SSE, WebSocket, and auth contracts
npm run test:e2e:migration      # upgrade an old SQLite schema through boot
npm run test:e2e:continuity     # plan/compaction continuity flow
npm run test:e2e:hooks          # public hook and plugin webhook flow
npm run test:e2e:delegate       # Delegate and parent result delivery
npm run test:e2e:subagent       # delegated child execution
npm run test:e2e:subagent:runner # delegated execution through the forked runner
npm run test:e2e:workflow       # workflow DAG dependency and resume behavior
node scripts/tests/recovery-e2e/run.mjs # restart-safe delegation recovery
```

The delegate E2E covers both delegated turns and workflow DAG behavior. Recovery E2E boots a real daemon, restarts it against the same SQLite database, and verifies fail-closed recovery and durable result handling.

## Sub-agent parity and deferred MCP checks

The in-process and forked sub-agent paths must produce byte-identical prompt and tool contracts. Run all parity variants when changing delegation, tool composition, prompt assembly, or MCP wiring:

```bash
npm run test:e2e:parity
npm run test:e2e:parity:runner
npm run test:e2e:parity:mcp
npm run test:e2e:parity:mcp:runner
npm run test:e2e:parity:mcp:deferred
npm run test:e2e:parity:mcp:deferred:runner
npm run test:e2e:lazy-mcp
```

The parity scripts compare against the checked-in baselines under `scripts/tests/subagent-parity/`. Update a baseline only when the wire contract intentionally changes and the change has been reviewed as such.

## CLI and terminal checks

Use the focused CLI tests during development:

```bash
npx vitest run tests/cli
npm run test:cli-tmux:built
npm run test:cli-tmux:goal
npm run test:cli-tmux:stop
npm run test:cli-tmux:analyze
```

`npm run test:cli-tmux` builds first and then runs the built CLI/TUI integration check. These checks need tmux. The daemon's embedded brain is not a tmux coding-agent process; tmux is the terminal backend and an integration dependency for these paths.

## Install smoke

`npm run test:install` verifies the artifact received by a new user rather than the source tree. It packs the npm tarball, checks that the package contains `dist/`, `web-dist/`, `prompts/`, and `plugins/`, then runs the first-unboxing flow in a clean `node:22` Docker container:

- `elowen --version`
- `elowen up`
- daemon health and setup mode
- first-admin creation
- authentication after setup
- web UI response
- `elowen down`

Run it from the repository root after installing both dependency trees. It requires Docker and is slower than the inner edit-test loop. The macOS CI variant runs the same check natively with `npm run test:install -- --native`.

## Static checks and builds

Use the narrowest relevant check first, then broaden for cross-cutting changes:

```bash
npm run lint
npm run typecheck
npm run deadcode
npm run depcruise
npm run languages-check
npm run check
npm run build
npm run build:web
```

`npm run check` is the static gate: lint, Knip, dependency-cruiser, daemon typecheck, and language checks. It runs no tests and no build. It also does not type-check the web application. Web TypeScript and production build errors surface through `npm run build:web` or the CI `web` job.

`npm run build` verifies the deterministic daemon/plugin artifact under `dist/`; it also builds bundled plugin browser sources. `npm run build:web` verifies the standalone `web-dist/` package artifact.

## Focused validation matrix

| Change area | Focused checks |
| --- | --- |
| Brain, daemon, or lifecycle | Relevant `tests/brain`/`tests/daemon` files, then `npm test`, `npm run lint`, and `npm run typecheck`. |
| API, auth, SSE, or WebSocket | `npx vitest run tests/api tests/contract`, then `npm run test:e2e:api`. |
| Store or migration | `npx vitest run tests/store tests/brain/persistence.test.ts tests/brain/partialTurnPersistence.test.ts`, then `npm run build` and `npm run test:e2e:migration`. |
| Web or plugin UI | Focused `npm --prefix web test`, then `npm run build:plugins-web`, `npm run build:web`, and browser E2E when the user path changes. |
| Plugin access, grants, or user config | `npx vitest run tests/api/pluginGrants.test.ts tests/api/pluginUserConfig.test.ts tests/plugins/toolGrants.test.ts tests/shared/pluginAccess.test.ts tests/store/userPluginConfigStore.test.ts`, then `npm run depcruise`. |
| CLI/TUI or terminal | `npx vitest run tests/cli`, then the relevant `test:cli-tmux:*` command and `npm run test:install` for packaging changes. |
| Delegate, sub-agent, or workflow | `npx vitest run tests/subagent tests/brain/workflow* tests/plugins/subagentRestartHandles.test.ts`, then delegate/workflow E2E and all relevant parity variants. |
| Core/plugin API boundary | Contract and plugin tests, then `npm run depcruise` and `npm run languages-check`. |

## CI

GitHub Actions runs on pushes and pull requests targeting `main`, with Node.js 22 and read-only repository permissions. The workflow currently contains these jobs:

- **Lint:** installs root and web dependencies, then runs ESLint, Knip, dependency-cruiser, and language checks.
- **Sandbox confinement:** verifies the bubblewrap terminal sandbox under the required AppArmor setup.
- **Daemon:** installs tmux, poppler utilities, ripgrep, and bubblewrap; builds, runs daemon tests, and checks the built CLI/TUI path.
- **Brain E2E:** runs real-daemon chat and stop/kill flows.
- **API E2E:** verifies REST/SSE/WebSocket and authentication behavior.
- **Migration E2E:** boots against an old-schema SQLite fixture.
- **Web E2E:** builds both artifacts and runs the built cross-stack browser harness.
- **Delegate E2E:** runs Delegate and workflow E2E against the built daemon.
- **Recovery E2E:** verifies delegation recovery across a daemon restart.
- **Web:** builds Next.js and runs the web Vitest suite; this is the CI web typecheck/build path.
- **Install smoke:** tests the packed npm tarball in Docker.
- **macOS smoke:** runs the packed-artifact first-run flow natively on macOS.

Before handing off a broad change, use the equivalent local checks rather than relying on `npm run check` alone. A practical baseline for changes spanning daemon and web is:

```bash
npm run check
npm test
npm run build
npm --prefix web test
npm run build:web
```

Add the focused E2E, browser, install-smoke, parity, or migration commands required by the changed boundary.
