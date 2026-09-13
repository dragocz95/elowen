# Development

Elowen is a TypeScript/ESM daemon with a Next.js web application, SQLite persistence, a CLI/TUI, and manifest-driven plugins. The daemon and web application have separate dependency trees and build commands.

## Prerequisites and setup

Use Node.js 22.12 or newer and npm; that is the floor declared in `package.json`, and an older 22.x release will be refused on install. Install `tmux` for CLI/TUI and real-daemon integration paths. Linux CI also installs `poppler-utils`, `ripgrep`, and `bubblewrap` for PDF, search, and confined-execution coverage.

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

A Project is the access boundary for a repository or directory. Elowen does not create or bind Git worktrees: isolated or parallel work uses native `git worktree` in the person's own checkout, and the conversation is pointed at that directory with `/cd` in owner chat or by starting the conversation there. A delegated child inherits the conversation's working directory and cannot widen it. Do not assume that the Project checkout is the working directory.

Keep unrelated changes, including another agent's worktree, out of the change. GitHub publication requires a committed `HEAD` on an Elowen-created branch; GitHub does not create or remove worktrees.

### Confined execution

A `Bash` command from an account without operator authority runs in a bubblewrap container built by `plugins/sandbox/lib/execution.mjs`. The container mounts only the account's accessible Projects and its account HOME, keeps `/usr` read-only, gives each command a fresh `/tmp`, and keeps the host network namespace so package installation, Git remotes and development servers work. If the live probe cannot establish confinement, the command is refused rather than run unconfined; an operator can set `confineNonOperators` to `false`, which lets granted non-operators run directly on the host.

Files tools (`Read`, `Write`, `Edit`, `Search`, `ListDir`, `Grep`, `Glob`, `FileInfo`) keep running on the host with the path guard, addressing the same tree the shell sees.

A sub-agent (`Delegate`) or workflow node spawned from a conversation inherits its working directory. A `read_only` child has no `Write` tool and no scratch directory beyond the per-command `/tmp`, so a plan or document it produces must be returned as the delegation RESULT for the parent to save; it cannot leave a file behind.

### Managed project environments

A Project declares its execution target rather than having one inferred from its path: either the host filesystem or a managed environment. A managed Project runs in its own persistent environment that survives across turns: a systemd-nspawn machine on a persistent disk, filled from a published root filesystem artifact that the host downloads and verifies against a pinned digest rather than building anything locally. The project volume is mounted under the project's own name (`/kolin` for a project with the slug `kolin`, and the environment's working directory), with a home volume and a data volume at `/data`, and each command running inside as a transient systemd unit. The machine's network is either shared with host loopback denied, or none at all.

The practical consequence when developing against a managed Project is that the file, shell, browser, editor, LSP, MCP and codebase surfaces reach the guest through the Sandbox control instead of the host filesystem, so a host path is not a meaningful address there. Guest file operations are a closed set that includes chunked writes for large uploads, and even a spilled tool result is written inside the guest and named by a guest path. Machine specifications are host-derived and frozen; a caller-supplied mount list is deliberately not an execution capability, and `prepareExecution` offers no way to request unconfined execution.

### Building a root filesystem artifact

The root filesystem those environments are built from is produced by `scripts/build-rootfs-artifact.mjs`, from the Project recipe in `plugins/sandbox/lib/rootfsCatalog.mjs`. Building needs `mmdebstrap` and `uidmap` on the host; the script checks before it starts and prints the `apt-get` line that installs what is missing rather than failing partway through a build.

```bash
npm run rootfs:build -- --all --out /tmp/rootfs
npm run rootfs:build -- --recipe project-base
npm run rootfs:verify
```

A build writes the tarball and a publish manifest to the output directory, and rewrites the pinned digests in `plugins/sandbox/lib/rootfsArtifacts.json`. It uploads nothing and holds no credential: publishing a built artifact to GitHub Releases is a separate step under the owner-only release authority, and the script ends by printing which release tag each file belongs to.

Two properties are worth understanding before changing anything here. The build is deterministic by construction, so the same recipe revision produces the same digest on a different host on a different day: the mirror is pinned to a `snapshot.debian.org` timestamp rather than to a floating suite, `SOURCE_DATE_EPOCH` clamps modification times, the shadow databases and host-derived caches are normalized, and gzip is asked to write neither a timestamp nor an original filename. Each of those has a comment saying which drift it removes, because dropping one leaves a build that still succeeds and quietly stops being reproducible. And nothing is pinned before the archive is inspected: the build reads back what it produced and refuses to record a digest unless the root member is present at mode 0755, the recipe's directories exist, its units are masked and enabled, `/etc/machine-id` is empty, no device nodes or escaping symlinks are present, and the unpacked size is within the catalogue's bound.

`npm run rootfs:verify` rebuilds and compares against the recorded pin, exiting non-zero on any difference. It needs no secret, which is what makes it runnable in CI. A recipe that is declared but has never been published has no digest to differ from, so it is skipped rather than compared — but skipped is not passed: a run that compared nothing exits non-zero and says so, because a verification that cannot fail reports a check that never happened. The Project root filesystem is published and pinned, so `rootfs:verify` rebuilds and compares it; a recipe edited without a version bump is also caught by the contract test in `tests/contract/rootfsArtifactPins.test.ts`, which holds the recipe and pin file to naming each other exactly once.

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
| `npm run dupes` | Report duplicate code blocks (jscpd). A report to read, not a gate: it stays outside `npm run check` and is non-blocking in CI. |
| `npm run languages-check` | Check Czech/English and plugin translation coverage. |
| `npm run check` | Run lint, Knip, dependency-cruiser, daemon typecheck, and language checks; it does not run tests or builds and does not type-check `web/`. |
| `npm --prefix web test` | Run web Vitest and React Testing Library tests. |
| `npm --prefix web run build` | Run the Next.js production build directly. |
| `npm --prefix web run e2e:smoke` | Run the fast Playwright `@smoke` subset. |
| `npm --prefix web run e2e` | Run the full Playwright suite. |
| `npm run test:install` | Pack and exercise the install artifact. |
| `npm run rootfs:build` | Build a managed-environment root filesystem and pin its digest. Takes `--all` or `--recipe <name>`. |
| `npm run rootfs:verify` | Rebuild every recipe and compare it against its recorded pin. |

`npm run build` does not build `web/`; use `npm run build:web` for the standalone web artifact. `npm run build:web` assembles static and public assets that Next.js does not copy into standalone output automatically.

## Generated artifacts

Build output is disposable and must not be hand-edited or committed:

- `dist/` contains compiled daemon output, copied prompts, copied plugin manifests/implementations, and generated bundled plugin browser assets.
- `plugins/*/web/` contains generated browser bundles; it is derived from `plugins/*/web-src/`.
- `web-dist/` contains the standalone Next.js package assembled by `npm run build:web`.
- The build's `prebuild` step runs `languages-check` and removes stale `dist/`; `postbuild` verifies output parity and executable bits.

`plugins/sandbox/lib/rootfsArtifacts.json` is generated too, but unlike the above it is committed: it carries the digests the daemon verifies downloads against, so a release has to ship them. It must still never be hand-edited. `scripts/build-rootfs-artifact.mjs` is its only writer, a digest in it is something a build measured after inspecting the archive it hashed, and a value typed in by a person is a pin nobody can reproduce.

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
- The `sandbox` plugin owns the account HOME, managed Project environments, process leases, and confinement preparation. Core consumes its typed control live and does not read its tables directly.
- Web host features live under `web/modules/`, `web/components/`, and `web/lib/`; plugin browser pages mount under `/p/<plugin>/` and must not import host `web/` sources.

The bundled plugin set is currently `askuser`, `changelog`, `elowen-docs`, `files`, `mcp`, `runtime-context`, `sandbox`, `statusline`, `subagent`, `terminal`, and `web`. Optional integrations such as scheduling, skills, codebase indexing, GitHub, platform adapters, LSP, editor, and other verticals are maintained in the curated `elowen-plugins` registry. Registry plugins are installed as plugin files and resolve required runtime packages from the daemon's declared dependencies; do not remove dependencies merely because their implementation is outside this checkout.

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

A bundled TypeScript plugin, if one is added here, gets `tsconfig.plugins.<name>.json` with `outDir` set to `plugins/<name>/dist`; `build:ts` discovers it through its glob. Bundled browser sources belong under `plugins/<name>/web-src/` and are built into generated `plugins/<name>/web/`. Plugin tests belong in the repository that owns the plugin. Registry plugins are tested in their owning registry checkout; they are not silently collected by this checkout's web Vitest configuration.

## Before handoff

Run the narrowest relevant test first. For daemon or plugin-host changes, normally run focused Vitest tests, `npm run lint`, and `npm run typecheck`. For web changes, run focused web tests and `npm run build:web`. For shared or cross-stack changes, use `npm run check`, `npm test`, the relevant builds, and the E2E or install checks listed in [Testing](TESTING.md).
