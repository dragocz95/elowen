# Development

Elowen is a TypeScript/ESM daemon with a Next.js web application, SQLite persistence, a CLI/TUI, and manifest-driven plugins. The daemon and web application have separate dependency trees and build commands.

## Prerequisites and setup

Use Node.js 22 or newer and npm. Install `tmux` for CLI/TUI and real-daemon integration paths. Linux CI also installs `poppler-utils`, `ripgrep`, and `bubblewrap` for PDF, search, and confined-execution coverage.

```bash
npm ci
npm ci --prefix web
```

Run the daemon and web application separately during development:

```bash
npm run serve
npm --prefix web run dev
```

The daemon defaults to `127.0.0.1:4400`; the Next.js development server defaults to port `3000` unless `PORT` is set. The web application reaches the daemon through `ELOWEN_DAEMON_URL`. Never put bearer tokens in browser-visible configuration.

## Worktrees and working directories

A Project is the access boundary for a repository or directory. The optional bundled `sandbox` plugin creates account-owned Git worktrees for a Project and binds one workspace to a conversation and Project. The generated branch has the form `elowen/u<account>/<label>-<id>`; the label is display text, not a raw Git ref.

When a Sandbox workspace is active, relative file operations and shell commands resolve to that worktree. Explicit paths are still checked against the account's Project access. Delegated children use a workspace only when `workspaceId` is explicitly passed; a child cannot widen its parent's workspace or authority. Do not assume that the Project checkout is the active working directory.

Sandbox commits accept explicit workspace-relative paths and never stage unrelated files. Keep unrelated changes, including other agents' worktrees, out of the change. GitHub publication consumes an active, committed Sandbox workspace; GitHub does not create or remove worktrees.

### The workspace container contract

Binding a workspace to a conversation (`SandboxCreateWorkspace` creates and binds in one step; `SandboxUseWorkspace` binds an existing one) changes how that conversation's shell commands run, for the instance operator's own conversation as much as for anyone else's. Every `Bash` command whose working directory lies inside an active workspace of the acting account runs in a bubblewrap container built by `plugins/sandbox/lib/execution.mjs`:

- The worktree is bind-mounted at `/workspace` and is the working directory; its host path never appears inside. `.git` is replaced by a read-only stub gitfile (`gitdir: /run/elowen-git-unavailable`), so `git` reports no repository. Commits go through `SandboxCommit` (explicit workspace-relative paths, message up to 500 characters).
- The account HOME is mounted at `/home/elowen` and persists between commands (`npm`, `pip`, tool caches). `/tmp` is a fresh tmpfs per command: nothing written there survives the command.
- `/usr` is read-only (with the usual `/bin`, `/lib`, `/lib64`, `/sbin` symlinks); `/etc` is an allow-list of read-only files (resolver, hosts, name switch, `passwd`/`group`, TLS certificates, locale and timezone, `gitconfig`, `npmrc`, `terminfo`); `/proc` and `/dev` are fresh. No `/var/www`, no other project, no systemd, no `sudo`, no `elowen` CLI and no control-plane token exist inside; the environment carries only `PATH`, `LANG`/`LC_*`, `TERM`, `TZ` and `HOME`, plus a connected GitHub credential for that one launch.
- Network stays shared by default (package installation, Git remotes, development servers); a site runtime may ask for an isolated network namespace.

Files tools (`Read`, `Write`, `Edit`, `Search`, `ListDir`, `Grep`, `Glob`, `FileInfo`) keep running on the host with the path guard, addressing the worktree by its host path, so a file the model writes and a command it runs see the same tree from two different mounts.

A sub-agent (`Delegate`) or workflow node spawned from a bound conversation inherits the binding: it starts in the worktree and its shell commands run in the same container without passing `workspaceId`. Passing `workspaceId` additionally pins the child's logical filesystem view to that worktree (workspace-relative paths, no wider host access). A `read_only` child has no `Write` tool and no scratch directory beyond the per-command `/tmp`, so a plan or document it produces must be returned as the delegation RESULT for the parent to save; it cannot leave a file behind.

To leave the container, release the binding rather than removing the workspace: `SandboxReleaseWorkspace` (the model tool; `projectId` narrows it to one Project), the `/sandbox` picker in the CLI and web, or `POST /plugins/sandbox/api/workspaces/release`. The next turn runs in the Project directory again; the workspace, its branch and its directory are preserved and can be re-activated. A release is refused with `workspace_in_use` while a process still runs in the worktree — wait for it or kill it first. The chat surfaces show a `Sandbox · <label>` badge (web telemetry foot) or a `[S] <label>` marker (CLI project line) while a conversation is bound.

## Commands

Run commands from the repository root unless a command explicitly uses `--prefix web`.

| Command | Purpose |
| --- | --- |
| `npm run serve` | Run the daemon directly from TypeScript. |
| `npm run build` | Run the language check, clean and compile `dist/`, build bundled plugin browser sources, and copy runtime inputs. |
| `npm run build:ts` | Run `tsc -b` for the daemon plus every discovered `tsconfig.plugins.*.json`; it does not enumerate plugin names. |
| `npm run build:plugins-web` | Bundle each `plugins/*/web-src/` entry into generated `plugins/*/web/` output. |
| `npm run build:web` | Build the standalone Next.js server and assemble `web-dist/`. |
| `npm test` | Run the daemon Vitest suite once. |
| `npm run test:watch` | Run daemon tests in watch mode. |
| `npm run lint` | Run ESLint. |
| `npm run typecheck` | Type-check the daemon without emitting files. |
| `npm run deadcode` | Run Knip unused-code analysis. |
| `npm run depcruise` | Check dependency boundaries and cycles across `src/`, `web/`, and bundled plugins. |
| `npm run languages-check` | Check Czech/English and plugin translation coverage. |
| `npm run check` | Run lint, Knip, dependency-cruiser, daemon typecheck, and language checks; it does not run tests or builds and does not type-check `web/`. |
| `npm --prefix web test` | Run web Vitest and React Testing Library tests. |
| `npm --prefix web run build` | Run the Next.js production build directly. |
| `npm --prefix web run e2e:smoke` | Run the fast Playwright `@smoke` subset. |
| `npm --prefix web run e2e` | Run the full Playwright suite. |
| `npm run test:install` | Pack and exercise the install artifact. |

`npm run build` does not build `web/`; use `npm run build:web` for the standalone web artifact. `npm run build:web` assembles static and public assets that Next.js does not copy into standalone output automatically.

## Generated artifacts

Build output is disposable and must not be hand-edited or committed:

- `dist/` contains compiled daemon output, copied prompts, copied plugin manifests/implementations, and generated bundled plugin browser assets.
- `plugins/*/web/` contains generated browser bundles; it is derived from `plugins/*/web-src/`.
- `web-dist/` contains the standalone Next.js package assembled by `npm run build:web`.
- The build's `prebuild` step runs `languages-check` and removes stale `dist/`; `postbuild` verifies output parity and executable bits.

The `files` list in `package.json` defines the packed artifact: `dist/`, `web-dist/`, `prompts/`, `plugins/`, selected `docs/site` pages, `README.md`, and `LICENSE`. Recreate generated output with the build commands rather than committing it.

## Repository layout and architecture boundaries

```text
src/                 daemon, API, brain, stores, CLI, plugin host, and shared contracts
plugins/             bundled plugin manifests and implementations
packages/             shared packages used by the daemon and plugins
prompts/              core prompt templates copied into dist/
tests/                daemon, API, CLI, store, plugin, contract, and E2E tests
web/                 Next.js App Router application and web tests
```

`src/daemon/brainCore.ts` is the single brain/store construction path. `src/daemon/bootstrap.ts` adds HTTP, authentication, platform startup, plugin services, runners, recovery, and shutdown. The forked sub-agent runner reuses `buildBrainCore()` but does not start the daemon, HTTP server, migrations, scheduler, or platform gateways.

- `src/api/routes/` owns HTTP route families; route dependencies and validated request shapes come from `src/api/context.ts`, `src/api/deps.ts`, and `src/api/schemas/`.
- `src/brain/` owns session lifecycle, turn execution, persistence, tool composition, permissions, memory hooks, channels, and delegation seams.
- `src/store/` owns core SQLite opening, migrations, and domain stores. Plugin-owned tables use the plugin migration API.
- `src/plugins/` owns manifest loading, staged registration, access policy, plugin lifecycle, marketplace installation, and live reloads.
- Core tools live in `src/brain/tools/`; plugin tools, routes, prompts, settings, services, and browser pages are registered through `PluginContext` and declared in the manifest.
- The `sandbox` plugin owns account HOME, Git worktrees, process leases, confinement preparation, explicit-path commits, and cleanup. Core consumes its typed control live and does not read its tables directly.
- Web host features live under `web/modules/`, `web/components/`, and `web/lib/`; plugin browser pages mount under `/p/<plugin>/` and must not import host `web/` sources.

The bundled plugin set is currently `askuser`, `elowen-docs`, `files`, `mcp`, `runtime-context`, `sandbox`, `statusline`, `subagent`, `terminal`, and `web`. Optional integrations such as scheduling, skills, codebase indexing, GitHub, platform adapters, LSP, editor, and other verticals are maintained in the curated `elowen-plugins` registry. Registry plugins are installed as plugin files and resolve required runtime packages from the daemon's declared dependencies; do not remove dependencies merely because their implementation is outside this checkout.

Core must not import plugin implementations or recreate their domain state. Consumers resolve plugin controls at call time so reloads cannot leave stale instances in long-lived closures. A failed plugin registration is not partially published: its tools and routes are discarded. Core routes win over explicitly declared plugin root mounts.

## Adding an API-backed web feature

1. Add or extend the route in the owning `src/api/routes/*.ts` family.
2. Define and validate request bodies in `src/api/schemas/`; wire dependencies through the existing route context and bootstrap path.
3. Add the matching client operation in `web/lib/elowenClient.ts`.
4. Expose reads and mutations through `web/lib/queries.ts` and `web/lib/mutations.ts`, including invalidation and rollback behavior.
5. Build the UI from shared components and add Czech and English user-facing strings.
6. Add focused daemon and/or web tests, then run the relevant checks in [Testing](TESTING.md).

Review authentication, authorization, Project ownership, account ownership, SSE behavior, and error responses for every new route. The `elowen api` CLI verb and daemon MCP endpoint use the same API boundary; browser safety alone is not sufficient.

## Adding plugin features

Keep a plugin's domain behavior, storage, routes, tools, UI, prompts, and lifecycle together. Use `PluginContext` and host contracts instead of importing host internals. Declare exact tool names and access levels in `elowen-plugin.json`, use `ctx.userConfig()` for account configuration, and obey the shared per-account access predicate.

A bundled TypeScript plugin, if one is added here, gets `tsconfig.plugins.<name>.json` with `outDir` set to `plugins/<name>/dist`; `build:ts` discovers it through its glob. Bundled browser sources belong under `plugins/<name>/web-src/` and are built into generated `plugins/<name>/web/`. Plugin tests belong in the repository that owns the plugin. Registry plugins are tested in `/var/www/elowen-plugins`; they are not silently collected by this checkout's web Vitest configuration.

## Before handoff

Run the narrowest relevant test first. For daemon or plugin-host changes, normally run focused Vitest tests, `npm run lint`, and `npm run typecheck`. For web changes, run focused web tests and `npm run build:web`. For shared or cross-stack changes, use `npm run check`, `npm test`, the relevant builds, and the E2E or install checks listed in [Testing](TESTING.md).
