# Project review — 2026-07

Full-codebase review split across parallel agents, one area per agent. An initial pass was
run, then a second **Fable** pass verified every finding (confirm / refute / correct scope)
and added the two missing categories. Findings are transcribed here so we can work through
the fixes together.

## Scope covered

| Category | Areas reviewed | Doc |
| --- | --- | --- |
| Bugs / correctness | `src/daemon` `src/api` `src/push` · `src/store` · `src/cli` `src/terminal` `src/tmux` `src/spawn` · `src/brain` | [bugs.md](./bugs.md) |
| Security | all REST routes, auth/tenancy, BFF, crypto, shell/tmux, data lifecycle | [security.md](./security.md) |
| Dead code | `src/**` `web/**` `plugins/**` `scripts/**` (manual pass beyond knip) | [dead-code.md](./dead-code.md) |
| Single source of truth | web ↔ daemon type/logic mirrors · chat-platform plugin adapters | [single-source-of-truth.md](./single-source-of-truth.md) |
| Quality / maintainability | `src/cli` · `src/store` `src/api` `src/daemon` · `src/brain` | [quality.md](./quality.md) |

## Fable verification (2026-07-20)

The bug findings came back **17/19 CONFIRMED, 0 refuted**, with two material corrections:
- **api#4 (NaN→500)** is narrower than first stated — only the two `limit` LIMIT-binds in
  `memory.ts:39,228` actually 500; WHERE-position `Number(param)` binds match nothing.
- **cli#1 (tmux prefix-match)** is worse — beyond killing the wrong session it enables
  **cross-user keystroke injection** into another user's live advisor.

The SSOT pass added a **new user-visible HIGH**: `web/lib/cron.ts` is a 4th copy of the cron
grammar that has drifted (drops the cron-expression branch), so the dashboard shows the wrong
next-run for cron-expression jobs. Quality came back with a SAFE-vs-RISKY classification and an
ordered execution list — see the foot of [quality.md](./quality.md).

## How to read severities

Each finding carries the reviewer's severity (**High / Medium / Low**) and a confidence
tag: **CONFIRMED** (traced end-to-end or reproduced) or **PLAUSIBLE** (statically traced,
real-world trigger not yet reproduced). Fix priority should follow severity, but note that
several "Low" items are unbounded-over-daemon-lifetime memory leaks, not one-shot glitches.
