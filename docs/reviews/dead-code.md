# Dead-code review — 2026-07-20 (Fable)

Manual pass beyond knip/depcruise (which are clean). Targets knip's blind spots: test files are entries
(so test-only-kept code passes), plugin `index.mjs` exports are exempt, `knip.json` suppressions. All
traced by hand.

## HIGH

1. **`BrainStore.removeForUser`** (`src/store/brainStore.ts:1146`) — zero prod callers, only tests. It's the
   only user-scoped brain-delete in the repo; the user-delete route never calls it → **data-hygiene bug, not
   a delete candidate**. Action: **wire it** into `DELETE /users/:id` (same as security H1 / bugs store#1).

2. **`UserPromptStore.removeForUser`** (`src/store/userPromptStore.ts:37`) — zero callers anywhere; duplicates
   the `DELETE FROM user_prompts WHERE user_id = ?` that `UserStore.delete` (`userStore.ts:131`) already runs.
   Action: remove (or consolidate the teardown here and call from `UserStore.delete` — one of the two must go).

3. **Five wholly dead web UI component files** (only their own tests import them):
   `web/components/ui/SettingCard.tsx`, `ThemeToggle.tsx`, `PageFrame.tsx` (`PageFrame` + `AdaptiveSplit`),
   `Section.tsx` (the `Section` uses in tasks/memory are *different local* components), `Surface.tsx`.
   Action: delete all five + their tests.

4. **`UserStore.userForToken`** (`userStore.ts:139`) + **`UserStore.refreshAgentToken`** (`:154`) — prod-dead.
   `userForToken` wraps `principalForToken` (the real guard path), 0 prod callers; `refreshAgentToken`
   (token rotation) is wired to no route/CLI/plugin. Looks like a live security primitive but nothing invokes
   it. Action: remove (retarget tests at `principalForToken`/`ensureAgentToken`), or wire rotation to an admin route.

## MEDIUM (prod-dead exports kept alive only by tests)

5. `MemoryStore.getEmbedding` (`memoryStore.ts:282`) — 0 prod callers.
6. `PushSubscriptionStore.listForUser` (`pushSubscriptionStore.ts:40`) — prod uses `listForUsers`.
7. `appendBufferedBrainEvent` (`liveEventReplay.ts:121`) — 0 refs even in-file; superseded by `SerializedEventBuffer`.
8. `bottomHints` (`chatComposition.ts:193`) + `startScreenHints` (`:221`) — UI renders via `*Items` + `fitSegments`.
9. `ConfigStore.providers()` (`configStore.ts:445`) — single test caller.
10. web: `epicCapacity` (`web/lib/taskTree.ts`), `lastClosedTask` (`web/lib/agentUtils.ts:135`), `modulesByGroup`
    (`web/modules/registry.ts`) — each 0 prod refs.
11. `pushUser` (`web/lib/transcript.ts:184`) — zero refs; `architecture.test.ts` explicitly asserts the CLI
    transcript must NOT export it → leftover of a deliberately removed API. Remove. (Same file: `groupToolItems`/
    `failureSignature`/`ToolGroup` are test-only in web but their daemon twins are prod-used — defensible parity,
    don't force. `emptyView`/`ChatView` export-only-for-tests, Low.)

## LOW

12. Orphan scripts: `scripts/smoke-brain.sh`, `scripts/smoke-chat.mjs`, `scripts/verify-openrouter.mjs` — referenced
    by nothing but their own headers. Delete or reference from docs.
13. `askUsesButtons` re-export in `plugins/discord/index.mjs:16` + `plugins/telegram/index.mjs:17` — alive in
    `lib/ask.mjs`, but the index re-export has zero consumers. Drop from both export lists.
14. `knip.json` stale suppressions — remove `@playwright/test`/`playwright` ignores; the i18n `types` suppressions
    hide nothing dead.
15. **Informational** — test hooks/fakes shipping in the npm tarball (`files: dist/`): `clearModelsCache`,
    `_resetDefaultCache`, `resetPtyLoader`, `FakeClock`, `FakeTmuxDriver`, `FakeInference`, `FakeGitReader`.
    Keep, or move fakes under `tests/` to slim the package.
16. **Informational** — ~30 web + many src symbols `export`ed only for tests (`INTERRUPT_CONFIRM_MS`,
    `LOCAL_SHELL_TIMEOUT_MS`, `REASONING_MARKER_DEBOUNCE_MS`, …). Alive code, optional de-export.

## Verified clean
No stale `dist/` copies (prebuild prunes); all deps trace to real consumers (`qrcode`→whatsapp, `monaco`
vendored, `postcss-import`→config); all 13 route files mounted; all 11 plugins' `provides.tools` match
registrations; no commented-out code / `if (false)` in src/web/plugins; i18n sampling found no confirmed
orphan keys (dynamic key resolution needs indirection-aware tooling for an exhaustive audit).
