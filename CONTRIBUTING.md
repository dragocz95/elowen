# Contributing to Orcasynth

Thanks for your interest in improving Orcasynth! This guide covers how to get set up
and what we expect from contributions.

## Getting started

Requires **Node ≥ 22** and **tmux**.

```bash
# Daemon
npm install
npm test
npm run build

# Web UI
cd web
npm install
npm test
```

## Project layout

- `src/` — the daemon: stores, overseer (mission engine, planner, scheduler, decision
  engine, janitor), spawn/tmux, deriver, REST API.
- `web/` — the Next.js front end (feature modules under `web/modules`).
- `docs/` — API, architecture, concepts, CLI, development, testing.

## Guidelines

- **Tests required.** New behavior needs tests. Run `npm test` (daemon) and
  `cd web && npm test` before opening a PR; both suites and `tsc` must be green.
- **Keep it typed.** TypeScript strict mode, no `any`. No empty `catch` blocks.
- **Root cause, not workarounds.** Fix the underlying issue; avoid dead code and duplication.
- **Small, focused PRs.** One concern per PR with a clear description.
- **Match the surrounding style.** Follow the conventions already in the file you're editing.

## Pull requests

1. Fork and create a feature branch.
2. Make your change with tests.
3. Ensure `npm run build`, `npm test`, and `cd web && npm test` pass.
4. Open a PR describing the change and the motivation.

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
