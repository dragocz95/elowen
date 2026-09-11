# Testing

Elowen has separate daemon and web dependency roots. Install both before cross-stack checks:

```bash
npm ci
npm ci --prefix web
```

Node.js 22.12 is the declared minimum and CI runs the current 22.x release. Install `tmux` for real-daemon and CLI/TUI coverage. Linux CI also installs `poppler-utils`, `ripgrep`, and `bubblewrap`; these cover real PDF extraction, the `Grep` tool, and confined execution.

## Daemon and contract tests

Daemon tests live in `tests/` and use the root Vitest configuration. They cover the API, brain/session lifecycle, providers, stores and migrations, CLI/TUI, terminal-plugin process lifecycle, bundled plugins, MCP, sub-agents, and cross-stack contracts.

```bash
npm test
npm run test:watch
npx vitest run tests/api/brainRoutes.test.ts
npx vitest run tests/store
npx vitest run tests/plugins
npx vitest run tests/contract
npx vitest run tests/cli
```

Use isolated temporary databases and Project directories. Prefer fake clocks, controlled provider/model servers, tmux drivers, transports, and local fixtures over live external systems. Add regression coverage at the route, service, store, plugin, or CLI boundary where the defect occurs.

`tests/contract/` protects invariants ordinary unit tests cannot see, including API/plugin/shared-package boundaries, manifest and browser-bundle contracts, language coverage, dependency declarations, build discovery, and generated `dist/` integrity. In particular:

- `tests/contract/registryPluginDependencies.test.ts` keeps runtime dependencies required by plugins in the external `elowen-plugins` registry in the daemon's `dependencies` and verifies their Knip exemptions match actual `src/` imports.
- `tests/contract/pluginBuildDiscovery.test.ts` verifies that `build:ts` discovers `tsconfig.plugins.*.json` rather than enumerating plugin names, and that TypeScript plugin output targets its own `plugins/<name>/dist`.
- `tests/contract/pluginWebTestHoming.test.ts` prevents browser tests from being stranded under bundled plugin `web-src/`; registry-owned plugin tests must run in their owning registry checkout.
- `tests/scripts/distIntegrity.test.ts` checks source/output parity, rejects unmanifested plugin folders, and verifies the real build removes stale output when run with `ELOWEN_DIST_BUILD_TEST=1`.

When a change affects a registry plugin, run its focused tests in that plugin's owning registry checkout as well as the host contract tests here. Do not copy registry implementation or tests into this repository to make the local suite green.

## Web tests and browser E2E

Web unit and component tests live in `web/tests/` and use Vitest, React Testing Library, user-event, and MSW:

```bash
npm --prefix web test
npm --prefix web run test:watch
npm --prefix web run build
```

Mock daemon calls with the shared MSW setup. Cover loading, error, mutation, optimistic-update, invalidation, keyboard/pointer interaction, focus, responsive behavior, and Czech/English copy where relevant.

The Playwright suite is under `web/tests/e2e/` and matches `*.e2e.ts`. It runs the real Next.js development server against a scriptable fake Hono daemon, preserving cookie, BFF proxy, EventSource, login, and transcript paths while replacing nondeterministic brain behavior. The configured projects cover authenticated and unauthenticated sessions; the harness uses throwaway ports, serial workers, and a fake daemon health endpoint.

```bash
npm --prefix web run e2e:smoke
npm --prefix web run e2e
```

Use the page objects and fixtures in `web/tests/e2e/`. Playwright reports and authenticated storage state are local output and must not be committed.

The built cross-stack browser job runs from the root:

```bash
npm run test:e2e:web
```

It builds `dist/` and `web-dist/`, starts the real built daemon and standalone web server, and runs `scripts/tests/web-e2e/run.mjs`. Use it when the production artifact, BFF proxy, setup flow, authentication, or server routing changes.

## Real-daemon E2E

These scripts build the daemon first, then use throwaway ports, databases, and scripted model servers:

```bash
npm run test:e2e:brain
npm run test:e2e:stop-kill
npm run test:e2e:api
npm run test:e2e:migration
npm run test:e2e:continuity
npm run test:e2e:hooks
npm run test:e2e:delegate
npm run test:e2e:subagent
npm run test:e2e:subagent:runner
npm run test:e2e:workflow
npm run test:e2e:recovery
```

The suites cover streamed chat and provider errors, stop/kill lifecycle, REST/SSE/auth contracts, old-schema upgrades, continuity and compaction, public hooks, delegated turns, forked runners, workflow DAG ordering/resume/stop, and restart-safe delegation recovery. The recovery suite restarts a real daemon against the same SQLite database and verifies fail-closed handling of unanswered tool calls and durable results.

## Sub-agent parity and deferred MCP

Run every relevant parity variant when changing delegation, tool composition, prompt assembly, or MCP wiring:

```bash
npm run test:e2e:parity
npm run test:e2e:parity:runner
npm run test:e2e:parity:mcp
npm run test:e2e:parity:mcp:runner
npm run test:e2e:parity:mcp:deferred
npm run test:e2e:parity:mcp:deferred:runner
npm run test:e2e:lazy-mcp
```

The parity scripts compare in-process and forked prompt/tool contracts with checked-in baselines under `scripts/tests/subagent-parity/`. Change a baseline only for an intentional reviewed wire-contract change.

## CLI and terminal

```bash
npx vitest run tests/cli
npm run test:cli-tmux:built
npm run test:cli-tmux:goal
npm run test:cli-tmux:stop
npm run test:cli-tmux:analyze
```

`npm run test:cli-tmux` builds first and then runs the built CLI/TUI integration check. These paths need `tmux`; tmux is the process driver used by this integration check, not a coding-agent process.

## Install smoke and generated artifacts

`npm run test:install` packs the npm tarball, checks that it contains `dist/`, `web-dist/`, `prompts/`, and `plugins/`, then runs the first-run flow in a clean `node:22` Docker container: `elowen --version`, `elowen up`, health/setup mode, first-admin creation, authenticated access, web response, and `elowen down`. It requires Docker. The macOS CI variant runs the same flow natively:

```bash
npm run test:install
npm run test:install -- --native
```

Build output is disposable. `npm run build` cleans and verifies `dist/`, compiles the daemon and discovered TypeScript plugin projects, builds bundled plugin browser sources, and copies prompts/plugins. `npm run build:web` assembles the standalone `web-dist/` package. Do not commit or hand-edit `dist/`, `web-dist/`, or generated `plugins/*/web/` bundles. The destructive real-build integrity test is intentionally isolated from the ordinary parallel suite in CI:

```bash
ELOWEN_DIST_BUILD_TEST=1 npx vitest run tests/scripts/distIntegrity.test.ts
```

## Machine runtime proof

`tests/plugins/environmentNspawnProof.test.ts` proves the systemd-nspawn runtime against a real machine. Everything it asserts is a property of something running — the capability bound, the seccomp mode, what a bind does to file ownership, what the cgroup holds, how long a command actually takes — so it cannot be established against a fake, and the suite skips with a named reason on a host that cannot hold a machine. A skip is not coverage; read the reason it prints.

It needs three root-owned artefacts an unprovisioned host does not have: the machine unit template, the polkit rule that lets the service account start those units without sudo, and a sudoers line naming one privileged helper. `tests/plugins/nspawnProofHost.mjs` installs them, runs the suite as the service account and takes the preparation away again, verifying the removal:

```bash
sudo node tests/plugins/nspawnProofHost.mjs run
sudo node tests/plugins/nspawnProofHost.mjs install
sudo node tests/plugins/nspawnProofHost.mjs uninstall
```

The helper it names is deliberately not the installed one. On a host where `/usr/local/libexec/elowen-site-gateway` is serving published sites, replacing it to test a branch would deploy that branch's whole Sites domain untested, so the harness installs a root-owned wrapper that runs the helper from the working tree and pins the sudoers line to the wrapper. The argv keeps exactly the shape the production drop-in pins; only the path moves. `ELOWEN_TEST_NSPAWN_HELPER` is what tells the suite which helper to talk to, and with it unset the suite proves the deployed runtime instead.

An artefact that already exists is left alone and never removed, so an operator who has provisioned the host keeps their own, and a receipt is written after each one so teardown can find whatever got as far as disk. The helper is copied to a root-owned path and the sudoers line names that copy, because a grant pointing at the working tree would be root on request for the account that can write it. The deployment record is not touched at all: the helper derives its trusted storage roots from the passwd home of the account that invoked it.

Every resource the suite creates is disposable and unmistakably its own: machines named after a throwaway project id and a `nsproof-` site, disks under the real storage roots, and a final case that asserts all of it is gone. Firewall rules for virtual-ethernet machines are reported, never installed — the daemon does not mutate the firewall and neither does a test.

## Static checks and builds

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

`npm run check` is the static gate: lint, Knip, dependency-cruiser, daemon typecheck, and language checks. It runs no tests or builds and does not type-check `web/`; web type and production errors surface through the web build and CI `web` job.

## Focused validation matrix

| Change area | Focused checks |
| --- | --- |
| Brain, daemon, or lifecycle | Relevant `tests/brain`/`tests/daemon` files, then `npm test`, `npm run lint`, and `npm run typecheck`. |
| API, auth, or SSE | `npx vitest run tests/api tests/contract`, then `npm run test:e2e:api`. |
| Store or migration | `npx vitest run tests/store`, then `npm run build` and `npm run test:e2e:migration`. |
| Web or bundled plugin UI | Focused `npm --prefix web test`, `npm run build:plugins-web`, `npm run build:web`, and browser E2E when the user path changes. Registry plugin UI also requires the registry checkout's tests. |
| Plugin access, grants, or user config | Focused plugin/API/store tests, `npx vitest run tests/contract`, then `npm run depcruise`. |
| Sandbox workspaces, paths, or execution | `npx vitest run tests/plugins/sandboxPlugin.test.ts tests/plugins/filesWorkspaceScope.test.ts tests/brain/gitBranch.test.ts`, then the relevant build and real-daemon path. |
| CLI/TUI or terminal | `npx vitest run tests/cli`, the relevant `test:cli-tmux:*` command, and `npm run test:install` for packaging changes. |
| Delegation, sub-agents, workflow, or MCP | Focused `tests/subagent`/`tests/contract` tests, delegate/workflow E2E, and all relevant parity variants. |
| Core/plugin API boundary | Contract and plugin tests, `npm run depcruise`, and `npm run languages-check`. |

## CI

GitHub Actions runs on pushes and pull requests targeting `main`, with Node.js 22 and read-only repository permissions. The current workflow jobs are:

- **Lint:** installs root and web dependencies, then runs ESLint, Knip, dependency-cruiser, and language checks.
- **Sandbox confinement:** installs bubblewrap/AppArmor setup and runs the required confined sandbox test.
- **Daemon:** installs `tmux`, `poppler-utils`, `ripgrep`, and `bubblewrap`; builds, runs daemon tests, runs the isolated `distIntegrity` real-build probe with `ELOWEN_DIST_BUILD_TEST=1`, and checks the built CLI/TUI path.
- **Brain E2E:** builds the real daemon and runs chat plus stop/kill flows.
- **API E2E:** builds the real daemon and verifies REST/SSE and authentication behavior.
- **Migration E2E:** boots an old-schema SQLite fixture and verifies migration.
- **Web E2E:** builds `dist/` and `web-dist/`, then runs the built cross-stack browser harness.
- **Delegate E2E:** runs delegated-turn and workflow E2E against the built daemon.
- **Recovery E2E:** verifies delegation recovery across a daemon restart.
- **Web:** installs only the web dependency tree, runs the Next.js build, and runs the web Vitest suite.
- **Install smoke:** packs the artifact and tests it in a clean Docker `node:22` container.
- **macOS smoke:** runs the packed-artifact first-run flow natively on macOS.

Before handing off a broad change, use the equivalent local checks rather than relying on `npm run check` alone. A practical daemon/web baseline is:

```bash
npm run check
npm test
npm run build
npm --prefix web test
npm run build:web
```

Add the focused E2E, browser, install-smoke, parity, registry, or migration checks required by the changed boundary.
