# Elowen agent instructions

## Scope

This repository is Elowen (`github.com/dragocz95/elowen`), a TypeScript daemon with a Next.js web UI and bundled plugins. Treat the checked-out code and `origin/main` as the source of truth. The old private Orcasynth/Claude instructions are not project architecture documentation.

## Working rules

- Read the real callers and focused tests before changing behavior.
- Reuse PI-native skills, compaction, steering, context files, and shared UI components before adding parallel mechanisms.
- Keep plugin behavior in the plugin; keep shared transport/runtime behavior in `src/`.
- Every bundled plugin is plain `.mjs` today: the four TypeScript ones (`agents`, `work`, `editor`, `lsp`) moved to the plugin registry (`github.com/dragocz95/elowen-plugins`), which compiles them itself. The rules still stand for the next one to land here — a TypeScript plugin gets its own `tsconfig.plugins.<name>.json`, picked up by `npm run build:ts` through a glob rather than by name, and may import from `src/` TYPE-ONLY (erased at compile time); core `src/` must never import from `plugins/`, and depcruise enforces both directions. Browser bundle sources live in `plugins/<name>/web-src/` (only `subagent` has one now) and must not import `web/` sources (they narrow `window.ElowenUiRuntime` locally). A plugin's own tests belong to whichever repo holds the plugin: nothing under `plugins/*/web-src/` is collected by the web suite any more, and `tests/contract/pluginWebTestHoming.test.ts` fails if a test file appears there.
- Do not touch unrelated worktree changes, especially `benchmark-env/`.
- After completing each logical change, create a scoped local git commit automatically. Do not wait for a separate commit request, never include unrelated worktree changes, and do not treat this rule as authorization to push.
- Preserve Czech and English user-facing text. Plugin manifests provide English fallback; add locale overrides under `plugins/<name>/i18n/<lang>.json`, including enum option labels when needed.
- `usage_by_origin` is the ONLY source of origin-attributed spend ("who burned the tokens, from where"). It is a write-time rollup precisely because `/usage/by-model` and `/usage/by-day` already scan `brain_messages` — the largest table — with per-row `json_extract`, on the daemon's synchronous event loop. Never answer an origin question with a query or join over `brain_messages`, whatever breakdown is asked for next; `tests/store/usageOriginPlan.test.ts` fails the build through `EXPLAIN QUERY PLAN` if you do. It is a SEPARATE counter from those views and is not expected to agree with them (it starts at deployment); do not present one as a check on the other.
- A client IP is read in exactly one place, `src/api/clientIp.ts`, and whether a proxy may be believed is decided there alone (`security.trustProxy`). The web BFF only forwards the nginx-set `x-real-ip`; it never makes a trust decision, and `x-forwarded-for`/`forwarded` stay off its allow-list because the client writes them itself.
- Do not push, publish npm packages, or deploy production unless the user explicitly asks.

## Validation

For daemon/plugin changes, run focused Vitest tests, then:

```bash
npm run lint
npm run typecheck
```

For web changes also run the focused web tests and `npm run build:web`.

The full build chain is `npm run build` = `npm run build:ts` (`tsc -b` over the
daemon plus every TypeScript plugin compile unit it discovers — none are bundled
today) followed by `npm run build:plugins-web` (esbuild of every
`plugins/*/web-src/` into the gitignored `plugins/*/web/index.js`) and the dist
copies. `npm run check` bundles lint, knip, depcruise, typecheck, and
languages-check.

## Production deploy

Only after explicit approval:

```bash
npm run build
npm run build:web                 # when web/ changed
sudo systemctl restart --no-block elowen-daemon elowen-web
```

The restart must be its own command. Wait for the recovered turn/process, then verify in a separate
command:

```bash
systemctl is-active elowen-daemon elowen-web
curl -fsS http://127.0.0.1:4400/health
```

The services run through `/var/www/.npm-global/lib/node_modules/elowen`, which is a symlink to this checkout. Verify both services are active and the web endpoint returns HTTP 200 after restart. Never run `npm publish` as part of a private deploy.

## UI and plugin conventions

- Use shared `HelpTip`, `ManageSelectionModal`, `SelectionSummary`, and model picker components instead of bespoke controls.
- Keep plugin config calm and compact; long explanations belong behind the shared help affordance.
- Plugin i18n can override field labels, hints, and enum option labels. Keep manifest English as the fallback.
- Discord per-channel presentation is resolved through `plugins/discord/lib/display.mjs`, which now lives in the plugin registry (`github.com/dragocz95/elowen-plugins`) rather than this repo; preserve independent overrides and legacy fallback behavior.
