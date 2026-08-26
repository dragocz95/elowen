# Development

Elowen is a TypeScript/ESM daemon with a Next.js web application, SQLite persistence, a CLI/TUI, and manifest-driven plugins. The daemon and web app have separate dependency trees and build commands.

## Prerequisites and setup

Use Node.js 22 or newer and npm. Install tmux when working on terminal, CLI/TUI, or real-daemon integration paths. Native `node-pty` is optional; when it cannot be built, terminal support can use its snapshot/SSE fallback.

```bash
git clone https://github.com/dragocz95/elowen.git
cd elowen
npm ci
npm ci --prefix web
```

Start the daemon from TypeScript:

```bash
npm run serve
```

Start the Next.js development server in a second terminal:

```bash
npm --prefix web run dev
```

The daemon defaults to `127.0.0.1:4400`. Next.js uses port 3000 in development unless `PORT` is set. The web app reaches the daemon through `ELOWEN_DAEMON_URL`; do not put bearer tokens in browser-visible configuration.

For an interactive built CLI:

```bash
npm run build
node dist/cli/bin.js --help
node dist/cli/bin.js chat
```

The installed `elowen` and `elo` commands resolve to the same CLI entrypoint.

## Commands

Run repository commands from the root unless a command explicitly uses `--prefix web`.

| Command | Purpose |
| --- | --- |
| `npm run serve` | Run the daemon directly from TypeScript. |
| `npm run build` | Compile TypeScript, build bundled plugin browser sources, copy runtime inputs, and verify `dist/`. |
| `npm run build:web` | Build the standalone Next.js server and assemble `web-dist/`. |
| `npm test` | Run the daemon Vitest suite once. |
| `npm run test:watch` | Run daemon tests in watch mode. |
| `npm run lint` | Run ESLint. |
| `npm run typecheck` | Type-check the daemon TypeScript project without emitting files. |
| `npm run deadcode` | Run Knip unused-code analysis. |
| `npm run depcruise` | Check dependency boundaries and cycles across `src/`, `web/`, and bundled plugins. |
| `npm run languages-check` | Check Czech/English and plugin translation coverage. |
| `npm run check` | Run lint, dead-code, dependency-cruiser, daemon typecheck, and language checks. It does not run tests or builds, and it does not type-check `web/`. |
| `npm --prefix web test` | Run the web Vitest/React Testing Library suite. |
| `npm --prefix web run test:watch` | Run web tests in watch mode. |
| `npm --prefix web run build` | Run the Next.js production build directly. |
| `npm --prefix web run e2e:smoke` | Run the fast Playwright browser subset. |
| `npm --prefix web run e2e` | Run the full Playwright browser suite. |
| `npm run test:install` | Pack and exercise the install artifact in the install-smoke environment. |

`npm run build` does not build `web/`; run `npm run build:web` when the web artifact is needed. `npm run build:web` creates a standalone server under `web-dist/`, including static and public assets that Next.js does not copy into standalone output automatically.

## Repository layout

```text
src/
├── api/            Hono server, route families, schemas, middleware, SSE
├── brain/          Sessions, turn pipeline, tools, memory, permissions
├── cli/            CLI commands, setup, install, launcher, update
├── daemon/         Boot, dependency wiring, loops, maintenance
├── embeddings/     Semantic embedding queue and service
├── git/            Read-only Git helpers
├── inference/      Provider clients and relay integration
├── integrations/   Project data and path-guard helpers
├── mcp/            Daemon MCP endpoint and tool bridge
├── plugins/        Plugin loader, registry, policy, marketplace, hooks
├── prompts/        Core prompt composition and catalog
├── push/           Web-push subscriptions and delivery
├── shared/         Cross-cutting contracts and utilities
├── store/          SQLite schema, migrations, and domain stores
├── subagent/       Delegation dispatch, runner pool, and IPC
├── terminal/       PTY/WebSocket terminal transport
└── tmux/           tmux driver and test fakes

plugins/            Bundled plugin manifests and `.mjs` implementations
packages/           Shared packages used by the daemon, plugins, and web UI
prompts/            Runtime prompt templates copied into `dist/`
tests/              Daemon, API, CLI, store, plugin, and contract tests
web/                Next.js App Router application and web tests
```

The current bundled plugins include `askuser`, `elowen-docs`, `files`, `mcp`, `runtime-context`, `statusline`, `subagent`, `terminal`, and `web`. Extracted verticals such as `agents`, `work`, `editor`, and `lsp` are maintained in the curated `elowen-plugins` registry, not in this checkout. Optional registry plugins are loaded through the host plugin contracts; core code must not recreate their domain state or import their implementation.

## Architecture boundaries

- `src/brain/service/spawner.ts` is the live-session spawn path. Session tool composition is owned by `src/brain/session/capabilities.ts`; it is the security boundary for owner, channel, delegated, and worker sessions.
- Typed delegation and workflows cross `src/brain/delegatedTurn.ts`, `src/brain/service/delegatedSession.ts`, `src/subagent/`, and the bundled `subagent` plugin. The workflow DAG implementation is in `plugins/subagent/lib/workflow.mjs`.
- `src/api/routes/` owns HTTP route families. `src/api/context.ts`, `src/api/deps.ts`, and `src/api/schemas/` provide route dependencies and validated request shapes.
- `src/store/db.ts` owns core SQLite opening and migrations. Domain stores own their tables and transactions. Plugin-owned tables must use the plugin migration API.
- `src/plugins/` owns manifest loading, staged registration, access policy, service lifecycle, marketplace installation, and plugin reloads. Plugin code reaches host capabilities through `PluginContext`.
- The CLI/TUI lives in `src/cli/` and `src/tmux/`; interactive terminal transport lives in `src/terminal/` and the daemon terminal service.
- Web host features live under `web/modules/`, `web/components/`, and `web/lib/`. Plugin browser pages live in the plugin's own web bundle and mount under `/p/<plugin>/`.

Per-account plugin grants and tool authority are deny-by-default policy surfaces. Use the shared predicates and host capability boundaries rather than checking account roles ad hoc in a route, tool, or UI component.

## Adding an API-backed web feature

1. Add or extend the route in the owning `src/api/routes/*.ts` family.
2. Define and validate request bodies in `src/api/schemas/`; wire dependencies through the existing route context and bootstrap path.
3. Add the matching client operation in `web/lib/elowenClient.ts`.
4. Expose reads and mutations through the React Query hooks in `web/lib/queries.ts` and `web/lib/mutations.ts`, including correct invalidation and rollback behavior.
5. Build the UI from `web/components/ui/` and existing host modules. Add both Czech and English user-facing strings.
6. Add focused daemon and/or web tests, then run the relevant checks in [Testing](TESTING.md).

Review authentication, authorization, project ownership, account ownership, SSE/WebSocket behavior, and error responses for every new route. The `elowen api` CLI verb and the daemon MCP endpoint use the same daemon API boundary; a route that is safe for the browser is not automatically safe for every caller.

## Plugins and extracted features

A bundled plugin has an `elowen-plugin.json` manifest and an entrypoint under `plugins/<name>/`. Manifest declarations are contracts: tools, API routes, browser navigation, settings, services, prompts, and MCP tools must be declared before registration.

When adding a plugin feature:

- keep domain behavior, storage, routes, tools, and UI together in the owning plugin;
- use `PluginContext` and the plugin API rather than importing host internals;
- declare exact tool names and access levels in the manifest;
- use `ctx.userConfig()` for per-account plugin configuration;
- make user-grantable plugins obey the shared per-account access predicate;
- place browser sources under the plugin's `web-src/` and do not import `web/` from a plugin bundle;
- add plugin tests in the repository that owns the plugin. Extracted plugins are tested in `/var/www/elowen-plugins`.

Core consumers must resolve plugin controls at call time so reloads cannot leave stale plugin instances captured in long-lived closures. If an owner plugin is unavailable, return the host's unavailable/503 state rather than fabricating an empty domain result.

## Database changes

For a core column:

1. Add it to `schema.sql` for fresh databases.
2. Add an idempotent additive migration in `src/store/db.ts`.
3. Add an index after the column migration when needed.
4. Add or update store tests and a migration test when existing databases are affected.

For a core table, define it in `schema.sql`; both fresh installs and boot migrations must produce the same shape. SQLite changes to checks, primary keys, or autoincrement behavior require a versioned, shape-guarded table rebuild. Never edit an already-shipped migration in place. Plugin-owned schema changes belong in that plugin's migration module.

Fresh-install defaults are defined in both `DEFAULT_CONFIG` and `defaultStored()` in `src/store/configStore.ts`; keep them consistent and preserve existing installations' stored values. Configuration changes also need the sanitizer, patch/update path, and live getter when the setting is intended to apply without a restart.

## Prompts, translations, and generated files

Core prompts live under `prompts/` and are catalogued through `src/prompts/`. External plugin prompts live with the plugin in the registry checkout. Keep prompt names stable because overrides and persisted settings use them as keys.

User-facing host text needs Czech and English entries. Plugin manifests provide English fallback; plugin-local translations live under `plugins/<name>/i18n/`.

Do not commit generated runtime state, credentials, logs, `dist/`, `web-dist/`, or hand-edited build output. Recreate generated artifacts with the build commands above.

## Before handing off a change

Run the narrowest relevant test first. For a daemon-only change, normally run focused Vitest tests, `npm run lint`, and `npm run typecheck`. For a web change, run focused web tests and `npm run build:web`. For a shared or cross-stack change, use `npm run check`, `npm test`, and the relevant build/E2E commands from [Testing](TESTING.md).
