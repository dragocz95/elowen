## Scope

This audit covers stale draft protection, server refreshes, concurrent mutations, close-during-save, and retry behavior in the host web and representative plugin surfaces. Sources inspected:

- Host shared persistence: `web/lib/useAutoSaveStatus.ts`, `web/lib/usePluginConfigDraft.ts`, `web/lib/mutations.ts`.
- Host settings and drawers: `web/app/settings/page.tsx`, `web/modules/settings/ContextWindowModal.tsx`, `web/modules/settings/ModelNoteModal.tsx`, `web/modules/memory/MemoryDetail.tsx`.
- Representative plugins: cron jobs, Microsoft Teams, MCP servers, Sites, and the project editor.
- Server persistence boundaries: `src/api/routes/plugins/index.ts` and `src/store/configStore.ts`.

The existing client controller is strong for one mounted resource: it debounces, serializes writes, keeps the latest callback/state, exposes `saving`/`saved`/`error`, flushes on teardown, and provides retry. The remaining material gap is cross-writer concurrency: no inspected write carries a server revision, ETag, or equivalent conditional-write token, so a stale but locally valid full snapshot can still overwrite a newer server value.

## Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Core Settings page: model/system/brain/data settings | `web/app/settings/page.tsx:221-237,272-292`; `web/lib/mutations.ts:21-24` | Local state is seeded once; shared autosave writes patches and invalidates `['config']`. Several independent controllers exist for maps/lists and scalar fields. | Partial |
| Context-window drawer | `web/modules/settings/ContextWindowModal.tsx:26-52` | Shared debounced autosave, validation, footer status, retry, and explicit flush on Done/close. | Partial |
| Model-note drawer | `web/modules/settings/ModelNoteModal.tsx:23-45` | Same autosave/flush/status pattern as context windows. | Partial |
| Memory edit drawer | `web/modules/memory/MemoryDetail.tsx:57-92,118-123` | One draft per memory; autosaves body/metadata/category; Done flushes and leaves edit mode. | Partial |
| Generic plugin config workspace | `web/lib/usePluginConfigDraft.ts:37-112`; `web/modules/settings/PluginDetail.tsx:58-110,114-152` | One shared draft for schema editor and custom preview; full values snapshot is serialized; status is shown at workspace level. | Partial |
| Cron job row/drawer | `plugins/cronjob/web-src/JobsSettings.tsx:246-365,569-715` | Row remains mounted after drawer close; one-job PUT; clean rows adopt server refreshes; dirty rows retain draft; delete waits for in-flight PUT; row-level retry survives close. | Partial |
| Microsoft Teams people/policy workspace | `plugins/msteams/web-src/TeamsWorkspace.tsx:50-56,269-405,409-533` | One shared plugin draft owns `rolePolicies`; people view and generic settings view deliberately avoid duplicate editors; policy changes use host autosave. Identity bind/sign-out are immediate actions. | Partial |
| MCP server drawer | `plugins/mcp/web-src/McpServersPage.tsx:169-305,357-395,450-477,593-609` | Explicit Save for server/process configuration; save is disabled while busy; refresh follows save/reconnect; errors are local to the editor. | Explicit-save justified |
| Sites detail drawer | `plugins/sites/web-src/SiteDetail.tsx:57-85,91-103,158-203,276-329` | Immediate PATCH/POST/DELETE mutations; public visibility and deletion require confirmation; guest list is diffed and written sequentially. | Explicit-save justified |
| Project editor | `plugins/editor/web-src/editor/ProjectEditor.tsx:71-81,141-159,183-205,207-230,365-380` | Explicit per-file Save/Cmd-S; per-path drafts remain visible during writes; each promise retires only the exact content it sent. | N/A |

## Missing or inconsistent auto-save

### 1. No conditional-write protection at the server boundary

The shared client controller serializes requests from one hook (`web/lib/useAutoSaveStatus.ts:45-67`), and plugin config adds a second serialization chain for full snapshots (`web/lib/usePluginConfigDraft.ts:52-70`). This prevents an older request from finishing after a newer request from the same controller, but it does not detect a newer write by another tab, another mounted editor, a plugin tool, or an operator.

- Core config update reads the current value and merges the incoming patch, but has no revision precondition (`src/store/configStore.ts:1178-1185`). Replacement structures remain last-writer-wins, including model context windows (`src/store/configStore.ts:1231-1234`) and other arrays/maps.
- The host mutation only invalidates the query after success (`web/lib/mutations.ts:21-24`); the response is not used as the canonical committed draft and no revision is retained.
- Plugin config applies values against the current stored object, but accepts no expected revision (`src/api/routes/plugins/index.ts:500-517`). Because `usePluginConfigDraft` sends the entire local `values` object (`web/lib/usePluginConfigDraft.ts:72-80`), a stale editor can overwrite unrelated fields that changed on the server meanwhile.
- Cron saves the whole row payload (`plugins/cronjob/web-src/JobsSettings.tsx:305-321`), so an external update to the same job while the row is dirty is overwritten by the next PUT.

Required invariant: every mutable resource needs a server version/generation (or ETag) and a conditional write. A conflict must remain visible and preserve the local draft; it must not be reported as `saved`.

### 2. Refresh protection is local, not conflict-aware

The host settings page intentionally seeds only once because focus refetches otherwise clobber edits (`web/app/settings/page.tsx:221-237`). This protects a local in-progress draft, but after an external change the stale local state remains authoritative for the next save. The same trade-off exists in the generic plugin draft: it re-seeds only when the plugin name changes (`web/lib/usePluginConfigDraft.ts:59-65`). The comments correctly identify clobbering, but there is no later clean-state reconciliation or conflict detection.

Cron is the best existing compromise: a server change is adopted when the row is clean, while a dirty draft is retained (`plugins/cronjob/web-src/JobsSettings.tsx:323-331`). However, a dirty row has no revision check, so the next full-row save can still revert fields changed by the scheduler or another editor.

Memory similarly skips resync while editing (`web/modules/memory/MemoryDetail.tsx:64-69`). Its PATCH is narrower than a full snapshot, which protects unrelated fields, but same-field changes remain last-writer-wins.

### 3. Close-during-save has inconsistent ownership of status

`useAutoSaveStatus` flushes pending work during teardown but deliberately lets an in-flight request outlive the component (`web/lib/useAutoSaveStatus.ts:90-102`). That preserves the write, but the unmounted surface cannot display a later failure or offer retry.

- Context-window and model-note drawers call `flush()` and immediately close (`web/modules/settings/ContextWindowModal.tsx:30-33`; `web/modules/settings/ModelNoteModal.tsx:24-27`). A failure after close has no visible retry path.
- Memory Done flushes and hides the status-bearing edit controls immediately (`web/modules/memory/MemoryDetail.tsx:90-92,118-123`). A failure can only become actionable if the user re-enters editing.
- Cron deliberately keeps the row mounted and renders status/retry in the table row (`plugins/cronjob/web-src/JobsSettings.tsx:246-249,447-450`), which is the correct lifecycle pattern.
- MCP permits the rail to close while `save()` is busy (`plugins/mcp/web-src/McpServersPage.tsx:357-360,593-609`). If the request then fails, `actionError` is set but the editor is already gone; there is no durable row-level retry surface (`plugins/mcp/web-src/McpServersPage.tsx:386-394`).

Required invariant: the controller owning a pending write must outlive the drawer/modal, or the parent must retain its draft, status, and retry action until the write settles.

### 4. Retry is not consistently durable

The shared indicator exposes an accessible retry action for `error` (`web/components/ui/AutoSaveStatus.tsx:7-26`), and the hook retries the current callback/state (`web/lib/useAutoSaveStatus.ts:104-105`). Core settings and plugin config therefore retain a retry path while their status owner remains mounted.

Gaps are lifecycle and mutation-specific:

- Core settings save failures are generally toast-only inside callbacks (`web/app/settings/page.tsx:245-258,277-292`); the page-level status is not consistently rendered for those settings.
- Sites reports mutation failures through a toast (`plugins/sites/web-src/SiteDetail.tsx:62-69,74-85`) with no retained failed draft or retry control.
- MCP retains an error only in the open drawer (`plugins/mcp/web-src/McpServersPage.tsx:386-394`), so close-before-failure loses operability.
- Invalid plugin JSON correctly remains editable and reaches `error` without a write (`web/lib/usePluginConfigDraft.ts:7-18`; `web/tests/modules/settings/usePluginConfigDraft.test.tsx:32-42`), but retrying an unchanged invalid draft simply repeats the validation failure. The UI should keep the error, but a conflict/error model should distinguish validation from transport/conflict failures.

### 5. Multiple controllers need an ownership rule

The core settings page uses separate autosave controllers for token TTL, context-window map, model catalog, auto-update, and push contact (`web/app/settings/page.tsx:272-292`). The server currently merges many top-level patches, so unrelated scalar updates are usually safe, but wholesale replacement maps/lists can still lose changes when two writers start from different baselines. The single-source-of-truth rule must be per logical resource, not merely per React component.

## Legitimate exceptions

- **MCP server configuration:** explicit Save is reasonable because it changes process lifecycle, transport, commands, environment/credentials, and scope. These are not ordinary low-risk scalar preferences. It still needs pending/error ownership outside the drawer.
- **Sites:** visibility changes, public publication, guest membership, rollback/restart, and deletion are explicit actions; public visibility and deletion already require confirmation (`plugins/sites/web-src/SiteDetail.tsx:91-103,304-329`). These should not be converted into blind debounce autosave.
- **Project editor:** explicit per-file Save is a document/workspace interaction, not a settings form. Its per-path draft and exact-sent-content retirement are a useful concurrency pattern (`plugins/editor/web-src/editor/ProjectEditor.tsx:183-205`).
- **Microsoft Teams identity bind/sign-out:** immediate mutations are appropriate for account-linking actions and replacement confirmation (`plugins/msteams/web-src/TeamsWorkspace.tsx:150-175,257-264`). Policy text/toggles remain ordinary autosave fields.

## Reusable existing pattern

`CronJobRow` is the strongest cross-lifecycle reference:

- The server list remains the canonical collection; each row owns only one resource (`plugins/cronjob/web-src/JobsSettings.tsx:251-257,569-571`).
- `draftRef`, `dirty`, `deleted`, `inFlight`, and `everSaved` separate local edits, lifecycle state, and network state (`plugins/cronjob/web-src/JobsSettings.tsx:283-298`).
- A successful write clears dirty state only if the exact sent draft is still current (`plugins/cronjob/web-src/JobsSettings.tsx:305-320`).
- Clean rows adopt server refreshes; dirty rows do not silently lose edits (`plugins/cronjob/web-src/JobsSettings.tsx:323-331`).
- Delete waits for an in-flight PUT and suppresses the unmount flush from recreating the row (`plugins/cronjob/web-src/JobsSettings.tsx:288-365`).
- Status and Retry remain on the row after the drawer closes (`plugins/cronjob/web-src/JobsSettings.tsx:447-455`).

The host `useAutoSaveStatus` plus `usePluginConfigDraft` is the reusable debounce/serialization foundation (`web/lib/useAutoSaveStatus.ts:7-24`; `web/lib/usePluginConfigDraft.ts:37-42`), but it needs a resource-level revision contract and a parent-owned settled/error state for unmounting surfaces.

## Tests and gaps

Existing tests provide good coverage for local races:

- Shared autosave tests cover seed suppression, debounce, status transitions, retry, unmount flush, Activity hide/show, and stale in-flight results (`web/tests/lib/useAutoSaveStatus.test.tsx:6-102`).
- Plugin draft tests cover invalid JSON, secret preservation, immediate commit failure, delayed activation, and serialized full snapshots (`web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105`).
- Core settings tests cover autosave and serialized retention failure/retry (`web/tests/app/settings.test.tsx:102-109,188-217`).
- Cron tests cover one-row writes, jobs added elsewhere, failed deletion, clean-row server adoption, and new-row persistence (`tests/cronjob-ui.test.tsx:318-409,412-493`).
- Editor tests cover newer typing during a write, cache-backed display after save, independent per-file promises, and preserving failed drafts (`tests/editor-ui.test.tsx:328-396`).

Missing focused coverage:

- Two tabs/editors writing the same core config, plugin config, cron job, or memory with an intervening server refresh.
- Server-side revision/ETag conflict responses and preservation of the local draft after a conflict.
- A dirty cron row or plugin config draft receiving an external same-field change before its save.
- Modal close while a save is in flight, followed by failure, and the resulting visible retry path.
- MCP close-before-failure and retry after the drawer has disappeared.
- Concurrent autosave controllers replacing the same map/list, especially model context windows, allowed models, model notes, and plugin `rolePolicies`.
- Reconciliation after an external refresh while the draft is clean, then a later edit; current seed-once behavior can save stale fields.

## Recommended migration notes

1. Establish one canonical resource contract: server payload, draft payload, revision/generation, pending request, terminal status, and retry callback must have one owner per logical resource.
2. Add conditional writes at the API boundary for full snapshots and important PATCH resources. Return a typed conflict rather than accepting an unguarded last-writer-wins overwrite.
3. Keep the cron row lifecycle model as the UI reference: clean refresh adoption, dirty draft preservation, exact-snapshot success checks, delete coordination, and status outside the drawer.
4. Separate validation errors, transport errors, and revision conflicts in the shared status model; only transport errors should offer blind retry, while conflicts should preserve the draft and require reconciliation.
5. For modal editors, move the save controller/status to a parent that remains mounted, or retain a row-level status surface. `flush()` alone is insufficient evidence that a close is safe because it cannot await an in-flight request.
6. Prefer narrow server patches for independent fields, or include a baseline revision with every full snapshot. Do not rely on query invalidation as conflict protection.
7. Add regression tests for each lifecycle boundary before changing individual surfaces; local serialization tests do not prove cross-tab or server-refresh safety.
