# Development

## Prerequisites

- Node.js 22 or newer
- npm
- tmux 3 or newer for agent and integration coverage
- A separately installed dependency tree for `web/`

`node-pty` is optional. When it cannot be built, the web terminal continues to
work through its snapshot/SSE fallback rather than real PTY streaming.

## Local setup

```bash
git clone https://github.com/dragocz95/elowen.git
cd elowen
npm install
npm install --prefix web
```

Run the daemon directly from TypeScript during development:

```bash
npm run serve
```

Run the web app in a second terminal:

```bash
npm --prefix web run dev
```

The Next.js application authenticates browser traffic through its same-origin
`/api` route handler. Configure the daemon URL through the supported runtime
configuration rather than adding browser-visible secrets.

## Commands

Run these from the repository root unless noted.

| Command | Purpose |
| --- | --- |
| `npm run build` | Clean `dist/`, compile TypeScript, copy runtime schema/prompts/plugins, make CLI bins executable, and verify the daemon artifact |
| `npm run build:web` | Build the standalone web server and assemble the package artifact in `web-dist/` |
| `npm test` | Daemon Vitest suite |
| `npm run test:watch` | Daemon tests in watch mode |
| `npm run test:cli-tmux` | Build then run the built CLI/tmux integration check |
| `npm run lint` | ESLint |
| `npm run typecheck` | Strict TypeScript check without emitting output |
| `npm run deadcode` | Knip unused-code check |
| `npm run depcruise` | Dependency-boundary and cycle check |
| `npm run check` | Lint, dead-code, dependency-cruise, and typecheck gates |
| `npm --prefix web test` | Web Vitest/RTL/MSW suite |
| `npm --prefix web run e2e:smoke` | Playwright browser E2E smoke suite (`e2e` for the full run) |
| `npm --prefix web run build` | Next.js production build |

For a built local CLI without a global link, invoke the declared executable:

```bash
node dist/cli/bin.js --help
node dist/cli/bin.js chat
```

`elowen` and `elo` both point to that same built entry after installation.

## Deterministic build artifacts

`npm run build` starts by removing `dist/`. It emits the TypeScript source,
then copies the daemon runtime inputs it needs: `src/store/schema.sql`,
`prompts/`, and `plugins/`. The post-build integrity check fails if emitted or
copied JavaScript differs from the expected artifact, so do not patch `dist/`
by hand.

`npm run build:web` builds `web/` with Next.js standalone output and assembles
`web-dist/`. It includes the standalone server, hashed `.next/static` assets,
and `public/` assets (including Monaco) because Next's standalone directory
does not include the latter two by itself.

## Source layout

```
src/
├── api/              Hono server, route families, schemas, middleware, SSE
├── brain/            Chat sessions, workers, events, tools, and turn state
├── cli/              CLI commands, setup/install flows, and interactive chat
├── daemon/           Bootstrap, dependency wiring, and recurring work
├── embeddings/       Shared embedding service and queue
├── inference/        Provider clients and relay integration
├── integrations/     Git/project data, CLI detection, usage collection
├── mcp/              Stateless MCP endpoint
├── overseer/         Missions, planning, scheduling, review, and decisions
├── plugins/          Manifest loader, registry, policy, hooks, marketplace
├── prompts/          Prompt composition helpers
├── shared/           Cross-cutting utilities, executor metadata, and the
│                     daemon↔web wire contract (`wireContract.ts`)
├── spawn/            Agent launch and resume paths
├── store/            SQLite stores and schema
├── terminal/         PTY terminal transport
└── tmux/             tmux driver abstraction and fakes
plugins/              Bundled plugin folders with `elowen-plugin.json`
prompts/              Runtime prompt templates copied into `dist/`
tests/                Daemon tests, broadly mirroring source areas
web/                  Next.js App Router frontend
web/app/              Route shells, API proxy, and global styles
web/components/       Shell, auth, terminal, control, and shared UI pieces
web/modules/          Feature modules and their views
web/lib/              Client, React Query hooks, i18n, and app state helpers
web/tests/            Web tests: Vitest/RTL/MSW plus the Playwright E2E harness
                      under `e2e/`
```

## Conventions

- Use strict TypeScript and ESM. Prefer constructor dependency injection and
  narrow interfaces at daemon boundaries.
- Keep HTTP glue in `src/api/routes/`; route context and dependencies belong in
  `src/api/context.ts` and `src/api/deps.ts`. Reuse route schemas from
  `src/api/schemas/` for request bodies.
- Prefer existing PI-native skills, compaction, turn context, and plugin APIs
  over parallel implementations.
- Keep shared daemon behavior in `src/`; plugin-specific behavior belongs in
  its plugin folder.
- Web data flows through `web/lib/elowenClient.ts`, React Query hooks in
  `web/lib/queries.ts`, and mutations in `web/lib/mutations.ts`. Reuse the
  shared UI controls in `web/components/ui/`.
- Add both Czech and English entries for user-facing web text. Plugin manifests
  retain English as fallback; plugin-local translations live in
  `plugins/<name>/i18n/<lang>.json`.

## Adding an API-backed web feature

1. Add or extend a route in the appropriate `src/api/routes/*.ts` family.
2. Put validated request bodies in `src/api/schemas/` and wire dependencies
   through the existing route context/bootstrap path.
3. Add the matching client call in `web/lib/elowenClient.ts`.
4. Expose cached reads or mutations through `web/lib/queries.ts` or
   `web/lib/mutations.ts`, including precise invalidation/rollback behavior.
5. Build the UI from shared components and add CS/EN translations.
6. Add focused daemon and/or web tests, then run the relevant verification
   commands in [Testing](TESTING.md).

The `elowen api` CLI verb and the MCP endpoint share the daemon's API path;
still review authentication, authorization, and agent-scope implications for
every new route.

## Pull requests and commits

Keep changes focused and conventional (`feat:`, `fix:`, `docs:`, `refactor:`,
and so on). Do not commit generated runtime data, credentials, private paths,
or hand-modified build artifacts. Run the proportionate tests before opening a
pull request.
