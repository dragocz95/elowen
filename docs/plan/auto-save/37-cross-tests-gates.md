# Scope

Audit of the host and registry test/gate coverage for autosave behavior: `useAutoSaveStatus`, debounce and queued writes, manual retry/error state, stale drafts and server refreshes, API payload boundaries, close/unmount behavior, and parity between source, copied runtime fixtures, and shipped bundles. Sources inspected: `/var/www/elowen` and `/var/www/elowen-plugins`.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Shared host `useAutoSaveStatus` controller | `/var/www/elowen/web/lib/useAutoSaveStatus.ts:7-24,26-105`; `/var/www/elowen/web/tests/lib/useAutoSaveStatus.test.tsx:6-102` | Seed guard, configurable debounce, serialized follow-up pass through `saveRef`, manual `retry()`, explicit `flush()`, and unmount flush. Unit tests cover seed/debounce, status success/failure, retry, unmount, Activity hide/show, and a purported stale-response case. | Partial |
| Host settings and account autosave integrations | `/var/www/elowen/web/tests/app/settings.test.tsx:102-217`; `/var/www/elowen/web/tests/modules/BrainLimitsModal.test.tsx:60-80`; `/var/www/elowen/web/tests/modules/account/TerminalSection.test.tsx:146-158`; `/var/www/elowen/web/tests/modules/account/AccountView.test.tsx:309-423` | Field-level or section-level autosave. Tests assert representative PATCH payloads, invalid custom-value suppression, clamped response display, one full terminal snapshot, partial profile patches, and stale `/auth/me` refetch protection. | Partial |
| Host generic plugin config draft | `/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-112`; `/var/www/elowen/web/tests/modules/settings/usePluginConfigDraft.test.tsx:32-105`; `/var/www/elowen/web/tests/modules/settings/PluginConfigEditor.test.tsx:94-122` | Debounced full-snapshot autosave with JSON validation, secret omission, serialized snapshots, immediate confirmed commits for destructive list changes, and draft preservation on failed commit. Tests cover these core paths. | Partial |
| Registry cronjob row editor | `/var/www/elowen-plugins/plugins/cronjob/web-src/JobsSettings.tsx:246-321,323-365`; `/var/www/elowen-plugins/tests/cronjob-ui.test.tsx:318-409,444-493` | Each row owns a debounced `useAutoSaveStatus` save; only one job is PUT; read-only `owner` is removed; invalid new rows do not save; delete waits for in-flight PUT; server changes are adopted when the row is clean. Picker “Save changes” confirms a local selection, not the server write. | Partial |
| Host/plugin save-state presentation and route handoff | `/var/www/elowen/web/components/ui/AutoSaveStatus.tsx:7-27`; `/var/www/elowen/web/tests/app/pluginHostPage.test.tsx:141-160,196-209` | Host indicator renders saving/saved/error and retry; standalone plugin sections receive an `onSaveState` channel, including frame-owning sections. Tests exercise the route-level error/retry handoff, not the real indicator for a real autosave failure. | Partial |
| Host runtime ABI parity | `/var/www/elowen/web/lib/pluginUi.tsx:275-358`; `/var/www/elowen/web/tests/lib/pluginUi.test.ts:104-174` | Production runtime publishes `AutoSaveStatus` and `useAutoSaveStatus`; frozen-name checks prevent withdrawal from the host maps. | Partial |
| Registry runtime stand-in parity | `/var/www/elowen-plugins/tests/ui/hostHooks.tsx:1-14`; `/var/www/elowen-plugins/tests/ui/useAutoSaveStatus.ts:1-110`; `/var/www/elowen-plugins/tests/hostRuntimeParity.test.ts:161-214` | Registry copies the hook and host hooks, then checks runtime map names against the installed `elowen` package. This protects names and API version, not copied behavior or prop semantics. | Partial |
| Registry source-to-shipped bundle gate | `/var/www/elowen-plugins/scripts/build-web.mjs:1-40`; `/var/www/elowen/scripts/build-plugins-web.mjs:1-27`; `/var/www/elowen-plugins/.github/workflows/ci.yml:30-45` | `check:web` rebuilds committed `web/index.js`/CSS and requires an empty diff; both registry CI and host builds run the relevant bundle build. | Partial |
| Built-plugin runtime/E2E path | `/var/www/elowen-plugins/tests/cronjob-ui.test.tsx:30-39,521-551`; `/var/www/elowen-plugins/tests/e2e/cron/run.mjs:1-9,119-191`; `/var/www/elowen/web/tests/e2e/specs/register.rowopen.e2e.ts:30-55` | Cron UI tests import `web-src` directly and only dynamically import the source entry for registration. Cron E2E covers scheduler/backend durability, not browser autosave. Host browser E2E measures register geometry/opening, not editing or saving. | Missing |

# Missing or inconsistent auto-save

- **The host stale-response regression is not testing overlapping requests.** `useAutoSaveStatus` serializes all writes while `running.current` is true (`web/lib/useAutoSaveStatus.ts:48-67`). The test claims save #2 resolves before slow save #1 (`web/tests/lib/useAutoSaveStatus.test.tsx:84-101`), but save #2 cannot start until save #1 settles. It therefore does not prove stale response protection or last-writer-wins behavior; it only exercises the queued follow-up path.
- **No deterministic debounce/coalescing matrix.** The hook test uses real wall-clock sleeps (`useAutoSaveStatus.test.tsx:7-14`), and integration tests generally wait up to three seconds. There is no fake-timer assertion for reset-on-each-edit, exactly-one request for a rapid burst, no request for the seed, or no request after an invalid value cancels a pending timer.
- **`ready`/`savable` edge cases are not directly covered by the hook suite.** There is no focused test for `ready=false → true` seeding, invalid → valid first edit, valid → invalid cancellation, or a pending valid save becoming invalid before the timer fires. The cronjob “new job” scenario (`cronjob-ui.test.tsx:442-452`) covers only one indirect invalid → valid case.
- **Retry coverage is mostly controller-level, not user-path coverage.** The hook unit test calls `result.current.retry()` (`useAutoSaveStatus.test.tsx:22-30`). The settings integration test recovers by editing another value (`settings.test.tsx:208-217`), not by clicking a rendered Retry control. No test verifies retry preserves the failed latest draft, does not duplicate queued writes, or reports `saving → saved` after retry in the actual settings/cron UI.
- **No real cronjob save-error/status test.** `cronjob-ui.test.tsx:229-245` tests a retryable *list query* error, not a failed row PUT. The cronjob suite has no assertion for `AutoSaveStatus` saving/saved/error, toast plus Retry after a PUT failure, or retrying the same row after the drawer is closed.
- **Close behavior is not exercised at the owning surfaces.** The hook has generic unmount-flush tests (`useAutoSaveStatus.test.tsx:32-57`), but no host form test closes/hides a panel with a pending edit and observes the real API write. Cronjob rows intentionally remain mounted when the detail rail closes (`JobsSettings.tsx:246-249`), so its close path is different from unmount flush and has no regression test.
- **Stale refresh coverage is uneven.** Account profile tests cover a held refetch and partial patches (`AccountView.test.tsx:309-423`), and cronjob tests cover a server change to an *untouched* row (`cronjob-ui.test.tsx:480-493`). Missing are same-row server refresh while dirty, a dirty-row refresh followed by another edit, and a stale refresh arriving while an autosave request is in flight for the same row/config.
- **API payload assertions are representative, not exhaustive.** Host tests check selected fields, while cronjob tests assert the edited id, selected values, and absence of `owner` (`cronjob-ui.test.tsx:340-351`). There is no contract test that captures the complete cronjob PUT payload and rejects all read-only projection fields (`owner`, scheduler-owned `lastRun`/`lastResult`, etc.), nor a direct host client test for method, URL encoding, JSON envelope, credentials, and non-2xx propagation for autosave calls.
- **No bundle execution parity for autosave.** Registry UI tests render `JobsSettings` from `web-src` (`cronjob-ui.test.tsx:6`) and load `web-src/index` for registration (`cronjob-ui.test.tsx:30-39`). `check:web` proves generated bytes are current, but no test imports/serves the committed `plugins/cronjob/web/index.js` and drives an edit through the runtime. A broken bundle-specific export, runtime lookup, or inlined dependency could therefore pass all autosave tests.
- **Runtime parity is name-only.** Host checks freeze the names `AutoSaveStatus` and `useAutoSaveStatus` (`web/tests/lib/pluginUi.test.ts:104-134`); registry parity compares extracted object keys and explicitly documents that it compares names, not props (`tests/hostRuntimeParity.test.ts:26-33,194-214`). It does not detect drift between the copied registry hook and host hook implementation, or a changed `AutoSaveStatus` prop/DOM contract.
- **No host-to-registry behavior gate.** The registry copy is documented as verbatim (`tests/ui/useAutoSaveStatus.ts:1-4`), but there is no source hash, AST comparison, shared fixture suite, or cross-runner behavioral matrix proving it remains equivalent to `/var/www/elowen/web/lib/useAutoSaveStatus.ts`.
- **No real browser autosave E2E.** The host E2E register suite reaches `/p/cronjob` only for row geometry/opening (`register.rowopen.e2e.ts:30-55`), while registry cron E2E is explicitly scheduler/backend-only (`tests/e2e/cron/run.mjs:1-9`). Neither types into a real built plugin, closes it, observes status, captures the PUT payload, or retries a failure.
- **CI gates run the tests but do not add autosave-specific gates.** Host web CI runs `npm test` (`/var/www/elowen/.github/workflows/ci.yml:308-325`); registry CI runs `npm test`, `check:web`, and `check:dist` (`/var/www/elowen-plugins/.github/workflows/ci.yml:30-45`). These are useful containers, but none explicitly requires fake-timer autosave coverage, built-bundle execution, or host/registry hook parity.

# Legitimate exceptions

- Secret values are intentionally not round-tripped: `usePluginConfigDraft` omits an untouched stored secret (`usePluginConfigDraft.test.tsx:44-56`). Requiring autosave to send a secret placeholder would risk clearing or exposing credentials.
- Destructive role-policy removal is an immediate confirmed commit, not a debounced edit (`usePluginConfigDraft.ts:28-30,83-101`; `PluginConfigEditor.test.tsx:94-122`). Confirmation plus immediate persistence is justified because the operation changes permissions and must not be silently delayed or resurrected by an older snapshot.
- Brain provider/credential operations retain explicit Save/OAuth flows (`web/tests/modules/settings/BrainSection.test.tsx:188-217,294-297`), appropriate for multi-provider and externally verified credential changes. Ordinary scalar settings and selectors should remain autosaved.

# Reusable existing pattern

- `useAutoSaveStatus` already provides the intended shared lifecycle: seed suppression, bounded debounce, serialized latest-state follow-up, visible status, manual retry, and flush (`web/lib/useAutoSaveStatus.ts:7-24,45-105`).
- `usePluginConfigDraft` adds a reusable full-snapshot serialization chain and commits only after server acceptance (`web/lib/usePluginConfigDraft.ts:52-101`), with focused tests for invalid JSON, secret omission, immediate destructive commits, and queued snapshots (`web/tests/modules/settings/usePluginConfigDraft.test.tsx:32-105`).
- Cronjob row ownership is a good data-boundary pattern: one row per PUT, projection-only `owner` removed, deletion ordered behind in-flight save, and clean-vs-dirty server adoption (`JobsSettings.tsx:251-257,288-321,323-365`).
- Runtime map freezing plus registry subset extraction prevents silent removal of published names (`web/tests/lib/pluginUi.test.ts:86-174`; `tests/hostRuntimeParity.test.ts:194-214`), but should be complemented by behavior/prop checks for autosave specifically.

# Tests and gaps

Existing regression classes:

- Seed value is not persisted; later edits debounce-save.
- Success/error status transitions and controller-level manual retry.
- Pending save flush on unmount and completion after unmount.
- React Activity hide/show liveness.
- Queued latest snapshot for generic plugin config.
- Invalid JSON and invalid custom numeric input do not claim persistence.
- Secret omission and destructive confirmed commit.
- Representative settings/account/cronjob payloads.
- Partial field patches protecting unrelated server changes.
- Clean-row adoption of server-side cronjob changes.
- Delete ordering and preservation of newly added/failed-delete cron rows.
- Runtime name/API-version and source-to-committed-bundle drift gates.

Missing regression classes to add:

- Fake-timer debounce reset/coalescing and seed/ready/savable transition matrix.
- A true overlapping-write or adversarial response-order test, or an explicit test proving serialization is the chosen invariant and that the latest snapshot is sent after the first settles.
- Failed real PUT → rendered error indicator → Retry click → successful PUT, for both a host form and the registry cronjob row.
- Pending edit followed by detail-rail close, Activity hide, route/category switch, and actual unmount; assert exactly one durable latest payload and no duplicate flush.
- Same-record stale server refresh during dirty editing and during an in-flight save; assert local draft wins until persistence and then adopts the confirmed server copy.
- Complete API transport/payload contract tests, including URL encoding, envelope, projection-field exclusion, credentials, non-2xx error propagation, and no whole-list overwrite.
- Execute the committed registry bundle, not only `web-src`, against the host runtime and exercise autosave through the real registration path.
- Cross-repository behavior parity for the host hook and registry copy, plus DOM/prop parity for `AutoSaveStatus`.
- Real browser E2E covering edit → status → close → reload/refetch → persisted value, with a forced failed save and retry.

# Recommended migration notes

- Treat the current stale-response unit test as a false-positive coverage signal: either rename it to queued-write coverage or replace it with a response-order test that matches the intended invariant.
- Centralize autosave regression fixtures around fake timers and deferred mutation promises; reuse them for host settings, `usePluginConfigDraft`, and registry cronjob rows rather than relying on wall-clock `waitFor` windows.
- Add one narrow built-bundle smoke path for the registry: serve/import `plugins/cronjob/web/index.js`, install the same runtime, edit a row, and capture the real PUT. Keep source-level tests for detailed behavior, but do not let them be the only execution path.
- Extend ABI parity only for the autosave contract: assert the hook option/return shape and `AutoSaveStatus` DOM states/Retry action, while retaining the broader name-only runtime surface gate.
- Keep explicit-save exceptions limited to secrets, destructive confirmed actions, credential/OAuth flows, and other atomic/external-verification boundaries; selectors and ordinary scalar fields should be covered by the shared autosave path.
