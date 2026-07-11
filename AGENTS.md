# Elowen agent instructions

## Scope

This repository is Elowen (`github.com/dragocz95/elowen`), a TypeScript daemon with a Next.js web UI and bundled plugins. Treat the checked-out code and `origin/main` as the source of truth. The old private Orcasynth/Claude instructions are not project architecture documentation.

## Working rules

- Read the real callers and focused tests before changing behavior.
- Reuse PI-native skills, compaction, steering, context files, and shared UI components before adding parallel mechanisms.
- Keep plugin behavior in the plugin; keep shared transport/runtime behavior in `src/`.
- Do not touch unrelated worktree changes, especially `benchmark-env/`.
- After completing each logical change, create a scoped local git commit automatically. Do not wait for a separate commit request, never include unrelated worktree changes, and do not treat this rule as authorization to push.
- Preserve Czech and English user-facing text. Plugin manifests provide English fallback; add locale overrides under `plugins/<name>/i18n/<lang>.json`, including enum option labels when needed.
- Do not push, publish npm packages, or deploy production unless the user explicitly asks.

## Validation

For daemon/plugin changes, run focused Vitest tests, then:

```bash
npm run lint
npm run typecheck
```

For web changes also run the focused web tests and `npm run build:web`.

## Production deploy

Only after explicit approval:

```bash
npm run build
npm run build:web                 # when web/ changed
sudo systemctl restart elowen-daemon elowen-web
curl -fsS http://127.0.0.1:4400/health
```

The services run through `/var/www/.npm-global/lib/node_modules/elowen`, which is a symlink to this checkout. Verify both services are active and the web endpoint returns HTTP 200 after restart. Never run `npm publish` as part of a private deploy.

## UI and plugin conventions

- Use shared `HelpTip`, `ManageSelectionModal`, `SelectionSummary`, and model picker components instead of bespoke controls.
- Keep plugin config calm and compact; long explanations belong behind the shared help affordance.
- Plugin i18n can override field labels, hints, and enum option labels. Keep manifest English as the fallback.
- Discord per-channel presentation is resolved through `plugins/discord/lib/display.mjs`; preserve independent overrides and legacy fallback behavior.
