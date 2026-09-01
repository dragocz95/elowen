# Host Editor and Terminal web surfaces audit

## Scope

Audit of host-owned web code in `/var/www/elowen`, excluding the implementation of registry plugins (including the moved `editor` plugin and the full browser terminal). Covered: the legacy Editor route and host launch points, host file-write transport used by the Editor plugin, account Terminal settings and its color drawer, read-only terminal previews/output modals, and host Monaco-based settings viewers/editors. Persistence was judged against the canonical experience: server-seeded state, debounced or immediate persistence, visible saving/saved/error feedback, retry, and protection against stale drafts or refreshes.

## Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Legacy `/editor` route | `web/app/editor/page.tsx:4-6`; `web/components/shell/PluginRedirect.tsx:5-15`; `web/tests/app/editorRedirect.test.tsx:15-27` | Host immediately replaces the historical URL with `/p/editor`, preserving query parameters. No editor state or save operation is owned by this route; the actual Editor UI is a registry plugin and is intentionally out of scope. | N/A |
| Projects → Editor entry points and project detail rail | `web/modules/projects/ProjectsView.tsx:68-90,323-385` | Host reads project/Git metadata and opens `/p/editor` for working tree, commit, or project links. The rail itself is read-only; content persistence belongs to the external Editor plugin. | N/A |
| Host file-write transport exposed to Editor | `web/lib/mutations.ts:346-375`; `web/tests/lib/writeProjectFile.test.tsx:43-98`; `web/tests/lib/mutations.test.tsx:89-114`; `web/lib/pluginUi.tsx:338-355` | `useWriteProjectFile` is an explicit mutation API for the plugin boundary, serializes writes per project+path, allows different files in parallel, updates the cache synchronously, and invalidates file/Git/changed-path queries. It does not itself debounce or render save status; those concerns remain with the plugin caller. | N/A |
| Account → Personality Monaco drawer | `web/modules/account/PersonalitySection.tsx:23-53,62-115`; `web/tests/modules/account/PersonalitySection.test.tsx:53-85` | Server-seeded once from `useMyCliSettings`; style and instruction body share one debounced `useAutoSaveStatus` save. The drawer editor is controlled, the status is rendered in the modal footer, and closing is safe because the shared hook flushes pending edits on teardown. | Compliant |
| Settings → Logs read-only Monaco viewer | `web/app/settings/page.tsx:878-901`; `web/modules/settings/LogsModal.tsx:37-123,125-257`; `web/tests/modules/settings/LogsModal.test.tsx:57-145` | Read-only log content is polled as a tail; filtering is local/deferred and full-file loading is explicit. There is no editable draft to persist. Delete actions are explicit and confirmation-protected; read failures distinguish 404/413/other and expose retry. | N/A |
| Account → Terminal settings | `web/modules/account/AccountView.tsx:47,306,308-326,362-364`; `web/modules/account/TerminalSection.tsx:32-73,121-225`; `web/lib/queries.ts:235-238`; `web/lib/mutations.ts:86-89`; `web/lib/elowenClient.ts:118-121`; `src/api/routes/auth.ts:242-253` | One server record is seeded once, then all appearance/CLI controls autosave through one debounced `useAutoSaveStatus` callback. The PATCH route/store re-validates and clamps untrusted input. Account-level feedback exposes saving/saved/error+retry in the active section header. | Compliant |
| Account → Terminal colors drawer and live preview | `web/modules/account/TerminalSection.tsx:54-61,82-119,227-233`; `web/components/terminal/TerminalPreview.tsx:35-77`; `web/tests/modules/account/TerminalSection.test.tsx:42-79` | The drawer edits the same local settings record as the page; palette changes, preset selection, theme mode, and preview are included in the existing autosave. Preview is explicitly non-interactive and renders the unsaved local settings, so it does not create a second persistence path. | Compliant |
| LiveTail terminal preview / expand affordance | `web/components/terminal/LiveTail.tsx:8-21,43-81`; `web/lib/useSessionPane.ts:5-19`; `web/lib/pluginUi.tsx:284-305` | Read-only ANSI tail fetched every two seconds while mounted; optional click/keyboard action delegates opening the full terminal to the caller/plugin. No draft or persistence is expected. `isError` is exposed by the query but ignored by `LiveTail`, so failures fall back to the same “no output” copy and have no retry. | N/A |
| Advisor background-process output modal | `web/modules/advisor/ProcessPanel.tsx:9-39` | Read-only output is fetched immediately and polled every 1.5 seconds while the process runs; cleanup prevents stale updates and clears the interval. No editable state or persistence is expected. Request failures are caught and leave the last/empty output displayed without an error or retry affordance. | N/A |
| Host chromeless terminal boundary | `web/components/shell/Shell.tsx:299-303,349-354`; `web/components/shell/DocumentTitle.tsx:24-29`; `web/lib/pluginUi.tsx:287-293` | The host only recognizes `/terminal/*` as a shell-free route and leaves its title/page rendering to the terminal surface. No host terminal route or editable terminal implementation is present in the audited web tree; the full terminal was moved out with the browser terminal/plugin surface. | N/A |

## Missing or inconsistent auto-save

- No missing autosave was found in host-owned editable Editor/Terminal settings. The actual project-file Editor implementation is external, so its draft/save behavior cannot be certified from this checkout; the host only supplies a race-safe mutation boundary (`web/lib/mutations.ts:346-375`).
- `LiveTail` has a non-persistence error-state gap: `useSessionPane` returns `isError` (`web/lib/useSessionPane.ts:10-19`), but `LiveTail` renders only loading, tail, or `noOutput` (`web/components/terminal/LiveTail.tsx:54-57`). A transient or permanent terminal read failure is therefore indistinguishable from an empty pane and cannot be retried in place.
- `ProcessOutputModal` similarly swallows output-read errors (`web/modules/advisor/ProcessPanel.tsx:18-24`) and renders `noOutput` when no output exists (`:35-37`). This does not lose editable data, but it weakens truthful terminal feedback and should be treated as a viewer-state gap rather than an autosave gap.
- Terminal settings deliberately seed only once (`web/modules/account/TerminalSection.tsx:53-63`). This prevents a query invalidation/refetch after an autosave from clobbering in-progress local edits. The shared hook additionally serializes follow-up saves and flushes on teardown (`web/lib/useAutoSaveStatus.ts:7-18,40-44,70-104`).

## Legitimate exceptions

- The legacy Editor route is only navigation glue; persistence is correctly owned by the registry Editor plugin rather than duplicated in the host.
- Logs are read-only. File deletion and “load full file” are explicit actions because deletion is destructive and a full-file read is a potentially large, user-requested operation (`web/modules/settings/LogsModal.tsx:109-123,194-207,251-284`).
- Project creation/editing adjacent to Editor launch remains explicit-save metadata administration (`web/modules/projects/ProjectsView.tsx:391-473`), not document editing. It is a multi-field admin operation with validation and a pinned footer, so treating it as a transactional form is preferable to saving each field independently.
- Project icon selection is an explicit discrete action (`web/modules/projects/ProjectIconPicker.tsx:18-21,46-50,90-95`), with double-click as an immediate shortcut. It is not Editor document content and should not be used as evidence about the Editor plugin's save model.

## Reusable existing pattern

Use `useAutoSaveStatus` plus `AutoSaveStatus`:

- `web/lib/useAutoSaveStatus.ts:7-24,26-31` defines the shared debounce, `ready` seed gate, `savable` validity gate, serialized latest-state follow-up, visible status states, flush, and retry.
- `web/lib/useAutoSaveStatus.ts:45-67,70-104` protects against overlapping stale writes, suppresses seed writes, holds invalid values, retries explicitly, and flushes pending edits on close/unmount.
- `web/components/ui/AutoSaveStatus.tsx:7-26` provides accessible saving/saved/error+retry rendering.
- `TerminalSection` is the clearest host example: seed once, build one canonical settings snapshot, save through the existing mutation, toast the error, and report status to the parent (`web/modules/account/TerminalSection.tsx:53-70`).
- For file content specifically, keep the per-document serialization and synchronous cache update already in `web/lib/mutations.ts:346-374`; a future host-owned text editor should add a debounced caller-level draft controller and visible status rather than bypassing this transport.

## Tests and gaps

- Editor route deep-link preservation is covered by `web/tests/app/editorRedirect.test.tsx:15-27`.
- File-write ordering, failure recovery, cache update, and related invalidation are covered by `web/tests/lib/writeProjectFile.test.tsx:43-98` and `web/tests/lib/mutations.test.tsx:89-114`.
- Personality drawer opening, load failure/retry, and combined autosave are covered by `web/tests/modules/account/PersonalitySection.test.tsx:36-85`.
- Terminal settings cover load errors/retry, server seeding, drawer/palette behavior, autosave, and sibling preservation in `web/tests/modules/account/TerminalSection.test.tsx:31-158`; CLI/daemon/web bounds and defaults are compared in `web/tests/modules/account/terminalCliParity.test.ts:39-72`.
- Shared autosave race/flush/error behavior is covered by `web/tests/lib/useAutoSaveStatus.test.tsx`; the implementation is the central regression surface for all compliant settings.
- Logs viewer loading, polling-without-flash, deleted/oversized file errors, stale-cache handling, truncation, and accessibility are covered by `web/tests/modules/settings/LogsModal.test.tsx:57-145`.
- There is no host test asserting `LiveTail` or `ProcessOutputModal` communicates a pane/output read failure or offers retry. Add focused viewer-state tests if those surfaces are kept host-owned; this is separate from autosave correctness.
- The external registry Editor plugin needs its own audit for draft seeding, autosave/explicit-save policy, save status, stale refetch protection, and close/unmount behavior. This report intentionally does not infer those properties from the host bridge.

## Recommended migration notes

1. Keep the host Editor route as a redirect only; do not reintroduce a second Editor implementation or a host-side save controller.
2. Require the registry Editor plugin to use the host's serialized `useWriteProjectFile` transport for same-file ordering and cache coherence, while implementing its own debounced draft/status policy at the document surface.
3. Preserve the TerminalSection architecture as the canonical host pattern: one seeded snapshot, shared autosave hook, visible parent feedback, and a drawer that edits the same state rather than a parallel draft.
4. Fix terminal viewer truthfulness separately: pass `isError` through `LiveTail` with retry, and expose a retryable error state in `ProcessOutputModal` instead of mapping failed reads to `noOutput`.
5. Add integration coverage in the registry-plugin repository for the real Editor user path; host tests can only verify redirect/query preservation and the write transport contract.
