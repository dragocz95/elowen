# Elowen agent instructions

## Scope

This repository is Elowen (`github.com/dragocz95/elowen`): a TypeScript daemon (`src/`), a Next.js web UI (`web/`), a CLI (`src/cli/`) and bundled plugins (`plugins/`). Treat the checked-out code and `origin/main` as the source of truth; `docs/` explains architecture, `CLAUDE.md` (gitignored) holds the private deployment facts of this box.

## Engineering rules

- **Smallest coherent fix of the root cause.** No output suppression, retries, delays or cosmetic masks in place of a repair.
- **No over-engineering.** Do not add abstractions, options, layers, registries or configuration for a need that does not exist yet. Three similar lines beat one speculative helper.
- **No fallbacks for things that never happen.** A branch is justified by a real caller, a real input or a real failure seen in production or in a test. Do not guard against impossible states, other versions we do not run, or hypothetical misuse. Fail loudly where the invariant matters; otherwise leave the code straight.
- **One source of truth.** Reuse the existing seam (PI-native skills, compaction, steering, context files, shared UI components, existing helpers) before adding a parallel mechanism. Two ways to do the same thing is a bug, not flexibility.
- **Preserve contracts.** Existing routes, stores, validation, permissions, i18n text and public plugin APIs stay unless the task deliberately changes them.
- **Review proportional to blast radius.** Ask for an adversarial review only for changes that touch permissions, persistence, restart/recovery, money/usage accounting or shared UI primitives. A small, tested change ships after its gates; do not spin review rounds that produce more code than the fix.
- **Read before writing.** Read the real callers, the focused tests and the config before changing shared behavior; verify a sub-agent's `file:line` claims yourself.
- Plugins: behavior of a plugin stays in the plugin, shared runtime in `src/`; core never imports from `plugins/` (depcruise enforces it). Bundled plugins are plain `.mjs`; a TypeScript plugin gets `tsconfig.plugins.<name>.json` and imports from `src/` type-only. Browser sources live in `plugins/<name>/web-src/` and must not import `web/`. Plugin tests belong to the repo that holds the plugin.
- Do not touch unrelated worktree changes. Other agents work in this checkout concurrently: for anything beyond a trivial edit, work in a git worktree off local `main` and merge back.
- After each logical change create a scoped local commit (stage by file name). Never push, publish npm packages or deploy production unless the user explicitly asks.
- Preserve Czech, Slovak and English user-facing text; every new string needs all three locales. Plugin manifests provide the English fallback with overrides under `plugins/<name>/i18n/<lang>.json`.
- `usage_by_origin` is the ONLY source of origin-attributed spend. Never answer an origin question with a query over `brain_messages`; `tests/store/usageOriginPlan.test.ts` enforces it. It is a separate counter from `/usage/by-model` and `/usage/by-day` and is not expected to agree with them.
- A client IP is read in exactly one place, `src/api/clientIp.ts`; the web BFF only forwards the nginx-set `x-real-ip` and never decides trust.

## Validation

Run the narrowest relevant test first, then broaden with the risk:

```bash
npx vitest run tests/<focused>          # daemon / plugin
cd web && npx vitest run tests/<focused> # web (the root config does not collect web tests)
npm run lint
npm run typecheck                        # daemon only; web types: npx tsc -p web/tsconfig.json --noEmit
npm run check                            # lint + knip + depcruise + typecheck + languages-check
```

Web changes also need `npm run build:web` (only works in the main checkout: Turbopack refuses symlinked `node_modules` in a worktree). Restart-sensitive changes get the real-daemon suites (`npm run test:e2e:recovery`, `test:e2e:workflow`, …); they build first and run against `dist/`.

Every behavioral fix gets the cheapest regression test that fails before the fix. Never weaken tests, types, lint or safety gates to get green.

## Build and restart

- `npm run build` = `build:ts` (`tsc -b` daemon + TypeScript plugins) → `build:plugins-web` (esbuild of `plugins/*/web-src/`) → copies of `schema.sql`, `prompts/` and `plugins/` into `dist/`. `tsc` emits even on errors and the chain stops at the first failure, so after a failed build check that `dist/store/schema.sql`, `dist/prompts` and `dist/plugins` carry the same timestamp as the fresh `.js`. `cp -r` merges: a plugin/skill/prompt deleted from source must also be removed from `dist/`.
- `npm run build` does NOT include `build:web`; the web bundle is built separately.
- The build reflects the worktree, not HEAD: `git status --porcelain` must be clean (apart from known foreign files) before building.
- Sub-agent runners fork the same `dist/`; a rebuilt `dist/` under a running daemon puts new runners into build-mismatch fallback until the daemon restarts. Build right before the restart.
- The daemon **pauses** on SIGTERM (parks running turns and sub-agents, checkpoints, exits in well under a second; `TimeoutStopSec=30`) and resumes them silently after boot. Restarts are cheap, but still announce them when other people's agents are running and let the owner decide.
- Web-only changes restart only `elowen-web`. Restart the daemon only when `src/` or a bundled plugin changed.
- Plugin server code is loaded once per boot (only the entry URL is cache-busted); a plugin fix needs a daemon restart. Plugin web bundles are read from disk per request; a hard reload suffices.

## Production deploy

Only after explicit approval (web-only changes are pre-approved unless told otherwise):

```bash
npm run build                     # when src/ or plugins/ changed
npm run build:web                 # when web/ changed
sudo systemctl restart elowen-daemon   # or only elowen-web
```

Then verify in a separate command:

```bash
systemctl is-active elowen-daemon elowen-web
curl -fsS http://127.0.0.1:4400/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4500/chat
```

Check the daemon log for `paused in`, `boot recovery` and `plugin loaded` lines and the absence of `plugin skipped` or `ERROR`. The services run through `/var/www/.npm-global/lib/node_modules/elowen`, a symlink to this checkout: building this checkout IS editing production. Never run `npm publish` as part of a private deploy.

## UI and plugin conventions

- Real shadcn/ui primitives (Radix + CVA) under `web/components/ui/shadcn/`; compose surfaces from them. Portals are removed on purpose (`overlayStack` makes other `<body>` children inert): render overlay content in place.
- Use shared `HelpTip`, `ManageSelectionModal`, `SelectionSummary`, `DataTable`, `Pager` and the model picker instead of bespoke controls.
- Design tokens live in `web/app/styles/tokens.css` and are mirrored for plugins in `packages/plugin-ui-kit/theme.css` (contract test). Never rename a token; add beside it. Skins (`web/skins/*`) only override tokens.
- Keep plugin config calm and compact; long explanations belong behind the shared help affordance. Plugin i18n can override labels, hints and enum option labels; manifest English is the fallback.
- Plugins receive UI components at runtime through `window.ElowenUiRuntime`; they never import `web/`.
