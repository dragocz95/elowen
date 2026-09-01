# OneDrive auto-save audit

## Scope

Audited the registry plugin at `/var/www/elowen-plugins/plugins/onedrive` and the host persistence surfaces it uses in `/var/www/elowen`.

Included:

- The manifest-declared admin configuration (`rootFolder`, `intervalSeconds`, `maxFileMb`, `extraIgnore`, and `applyRemoteDeletions`).
- The project web panel and its read-only overview/status states.
- Project and sandbox-workspace sync-root selection, including folder browsing and remote-path previews.
- Conflict listing and local/remote resolution.
- Pause/resume, Sync now, bulk-deletion confirmation, disconnect, and external-folder actions.
- The plugin API routes, SQLite mirror/baseline persistence, background sync, stale-state protection, and trash behavior.

The manifest loads `dist/index.js` and `web/index.js` as the runtime entrypoints (`/var/www/elowen-plugins/plugins/onedrive/elowen-plugin.json:7,67-70`).

## Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Admin plugin configuration: `rootFolder`, `intervalSeconds`, `maxFileMb`, `extraIgnore`, `applyRemoteDeletions` | `/var/www/elowen-plugins/plugins/onedrive/elowen-plugin.json:30-65`; `/var/www/elowen/web/modules/settings/PluginDetail.tsx:58-110,134-152`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:632-742,904-920` | Schema-driven draft. Every field change enters the shared `usePluginConfigDraft` debounce (900 ms), which serializes full-snapshot writes, validates JSON where applicable, and exposes saving/saved/error+retry status. The host `PATCH /plugins/:name/config` merges the patch, validates number/token-list values, persists before reload, and reports deferred activation as `202 pending` (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:43-112`; `/var/www/elowen/web/lib/useAutoSaveStatus.ts:7-17,45-105`; `/var/www/elowen/src/api/routes/plugins/index.ts:62-106,126-137,500-518`). | **Compliant** |
| Project overview and mirror status card | `/var/www/elowen-plugins/plugins/onedrive/web-src/OneDriveProjectPanel.tsx:250-333`; `/var/www/elowen-plugins/plugins/onedrive/src/api.ts:68-99` | Read-only query with a 15-second refresh, loading/error states, status badges, file counts, mirrored subpath, and remote destination. No local draft is being edited. | **N/A** |
| Project sync-root connect drawer and folder picker | `/var/www/elowen-plugins/plugins/onedrive/web-src/OneDriveProjectPanel.tsx:90-171,263-275,405-458`; `/var/www/elowen-plugins/plugins/onedrive/src/api.ts:102-155,159-217` | Folder browsing is query-only; the selected `subpath` remains local until the user explicitly presses `Start mirroring`. That action creates/ensures a OneDrive folder, upserts the mirror link, resets the baseline when the target changes, and starts a sync. | **Explicit-save justified** |
| Sandbox-workspace sync roots | `/var/www/elowen-plugins/plugins/onedrive/web-src/OneDriveProjectPanel.tsx:336-403,407-458`; `/var/www/elowen-plugins/plugins/onedrive/src/index.ts:30-49`; `/var/www/elowen-plugins/plugins/onedrive/src/sync.ts:65-83`; `/var/www/elowen-plugins/plugins/onedrive/src/store.ts:91-163` | Each workspace has a separate explicit connect flow. Workspace identity and label are validated server-side; the remote path includes the workspace id, and project/workspace folders remain siblings. One mirror per account/project/workspace is enforced by a unique index and upsert. | **Explicit-save justified** |
| Pause/resume controls | `/var/www/elowen-plugins/plugins/onedrive/web-src/OneDriveProjectPanel.tsx:232-245,355-377`; `/var/www/elowen-plugins/plugins/onedrive/src/api.ts:244-252`; `/var/www/elowen-plugins/plugins/onedrive/src/store.ts:261-264` | Immediate `POST /pause` mutation. The server persists `enabled` and status atomically; the sync loop re-reads liveness and stops applying work after a mid-cycle pause (`/var/www/elowen-plugins/plugins/onedrive/src/sync.ts:367-409`). | **Explicit-save justified** |
| Manual Sync now | `/var/www/elowen-plugins/plugins/onedrive/web-src/OneDriveProjectPanel.tsx:241-243,378-381`; `/var/www/elowen-plugins/plugins/onedrive/src/api.ts:255-271` | Immediate, explicitly scoped `POST /sync-now`; the route passes `only: Set([link.id])`, so a row action cannot silently sync every mirror. The engine coalesces ordinary duplicate requests for an account (`/var/www/elowen-plugins/plugins/onedrive/src/sync.ts:107-143`). | **Explicit-save justified** |
| Bulk-deletion refusal and confirmation | `/var/www/elowen-plugins/plugins/onedrive/web-src/OneDriveProjectPanel.tsx:208-221,358-369`; `/var/www/elowen-plugins/plugins/onedrive/src/api.ts:255-271`; `/var/www/elowen-plugins/plugins/onedrive/src/sync.ts:338-365`; `/var/www/elowen-plugins/plugins/onedrive/src/store.ts:218-222` | The engine blocks excessive local-to-OneDrive deletions and stores the exact shown count. The danger action is separate from ordinary Sync now; confirmation is one mirror/one run, must answer an actual refusal, and cannot cover more deletions than were shown. | **Explicit-save justified** |
| Conflict drawer and resolution | `/var/www/elowen-plugins/plugins/onedrive/web-src/OneDriveProjectPanel.tsx:30-77,223-229,460-462`; `/var/www/elowen-plugins/plugins/onedrive/src/api.ts:275-363`; `/var/www/elowen-plugins/plugins/onedrive/src/store.ts:295-312` | Conflict listing is query-only. Choosing the project or OneDrive version is an explicit mutation. Resolution checks ownership, root containment, Microsoft-drive identity, and the recorded remote ETag; the losing version is moved to `.elowen-trash` rather than discarded. | **Explicit-save justified** |
| Disconnect confirmation | `/var/www/elowen-plugins/plugins/onedrive/web-src/OneDriveProjectPanel.tsx:267,464-471`; `/var/www/elowen-plugins/plugins/onedrive/src/api.ts:233-240`; `/var/www/elowen-plugins/plugins/onedrive/src/store.ts:266-284` | Explicit `ConfirmDialog` followed by immediate `POST /disconnect`. The local link and baseline are deleted, while the remote OneDrive folder is deliberately left untouched. | **Explicit-save justified** |
| Open folder in OneDrive | `/var/www/elowen-plugins/plugins/onedrive/web-src/OneDriveProjectPanel.tsx:232-236`; `/var/www/elowen-plugins/plugins/onedrive/src/api.ts:82-89` | External navigation only; no persistence. | **N/A** |

## Missing or inconsistent auto-save

- The admin configuration path is consistently auto-saved and has the required stale-draft protection: refetches do not reseed an active draft, writes are serialized, and unmount flushes a pending debounce (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-42,52-80`; `/var/www/elowen/web/lib/useAutoSaveStatus.ts:15-17,90-105`). No OneDrive-specific config migration is needed for auto-save.
- The project-level Pause/Resume button is not disabled while its mutation is pending (`OneDriveProjectPanel.tsx:243`), while workspace-row controls do disable on `pause.isPending` (`:372-375`). This is an action-feedback inconsistency, not an auto-save omission, but it permits duplicate clicks.
- Disconnect has no pending-state prop or disabled confirmation control (`OneDriveProjectPanel.tsx:464-471`). The mutation stays open on failure and reports a toast, but there is no explicit in-dialog saving/error state. Add pending protection if the shared `ConfirmDialog` supports it.
- Sync now and deletion confirmation disable on `syncNow.isPending` and surface failures through the host toast (`OneDriveProjectPanel.tsx:217-221,241-243,364-381`; `:269-293`). This is acceptable for an explicit action, but there is no durable inline retry affordance beyond pressing the same action again.
- Conflict resolution has good pending protection and an inline error surface (`OneDriveProjectPanel.tsx:37-47,66-76`), but the rendered `ErrorState` has no `onRetry`; retry is only implicit through the resolution buttons after the mutation settles. The route itself safely rechecks the conflict and returns `409` when OneDrive changed (`api.ts:312-318`).
- `applyRemoteDeletions` is auto-saved without an extra confirmation or risk badge (`elowen-plugin.json:60-65`; generic boolean rendering at `PluginConfigEditor.tsx:660-664`). This is not a destructive immediate operation: the setting changes future behavior, and the enabled path moves local files into `.elowen-trash` rather than unlinking them (`sync.ts:464-497,611-647`). The explicit deletion confirmation remains correctly reserved for the opposite, local-disappearance-to-OneDrive direction.
- There are no rendered OneDrive web tests covering drawer lifecycle, mutation pending/error states, stale overview refreshes, duplicate clicks, or the real connect/conflict/deletion-confirmation journey. Existing coverage is predominantly API, sync-engine, manifest, and static string parity.

## Legitimate exceptions

- **Connect / sync-root selection:** explicit confirmation is justified because it creates or reuses a remote folder and starts bidirectional file transfer. A folder choice must not be silently committed merely because the picker was opened.
- **Pause/resume:** this is an immediate operational command, not a draft setting. It changes whether background work is allowed to run.
- **Sync now:** this is a user-requested execution command, scoped to one mirror rather than a value to debounce.
- **Bulk-deletion confirmation:** explicit confirmation is required because the operation can remove multiple OneDrive files. The engine's stored count, refusal state, and one-run scope are appropriate safeguards (`sync.ts:345-365`).
- **Conflict resolution:** selecting which version wins is an explicit decision about two copies. Conditional ETag checks and trash preservation make the operation recoverable without turning it into a silent background overwrite (`api.ts:312-361`).
- **Disconnect:** explicit confirmation is appropriate because it removes the local mirror link and baseline. Leaving remote files untouched is the correct authority boundary (`store.ts:266-273`).
- **`applyRemoteDeletions`:** no confirmation is required for the configuration toggle itself because its behavior is reversible at the file level: the enabled path trashes the local copy, while the disabled path restores the local copy to OneDrive (`sync.ts:464-497`; `/var/www/elowen-plugins/tests/onedriveSync.test.ts:624-652`).

## Reusable existing pattern

Use the host's generic plugin configuration path unchanged:

1. `usePluginConfigDraft` seeds from server values once per plugin, keeps newer edits isolated from refetches, debounces for 900 ms, serializes full snapshots, validates before writing, and flushes on close/unmount (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-112`).
2. `useAutoSaveStatus` provides `saving`, `saved`, `error`, retry, and flush semantics with stale/in-flight write handling (`/var/www/elowen/web/lib/useAutoSaveStatus.ts:7-24,45-105`).
3. `AutoSaveStatus` renders the visible status and retry affordance (`/var/www/elowen/web/components/ui/AutoSaveStatus.tsx:7-26`).
4. The plugin route applies a validated merge patch, persists first, and distinguishes delayed live activation from a failed write (`/var/www/elowen/src/api/routes/plugins/index.ts:62-86,116-137,500-518`).

For OneDrive project actions, retain the existing typed mutation pattern: send only the affected mirror id, invalidate the overview on success, keep the drawer open on failure, and revalidate ownership/target/version at the API boundary (`OneDriveProjectPanel.tsx:269-293`; `api.ts:221-231,300-318`).

## Tests and gaps

Existing tests provide strong persistence and destructive-operation coverage:

- Manifest route parity and all localized panel keys: `/var/www/elowen-plugins/tests/onedriveApi.test.ts:114-170`.
- Request-body parsing, per-mirror scoping, ownership isolation, pause/resume, and conflict resolution including stale ETag rejection: `/var/www/elowen-plugins/tests/onedriveApi.test.ts:173-247,249-314`.
- Project/workspace remote layout, workspace-id separation, path normalization, and ignored-root rejection: `/var/www/elowen-plugins/tests/onedriveSync.test.ts:213-242,468-507`.
- Mid-cycle pause, trash preservation, remote-deletion policy, conflict freezing, and local disappearance blocking: `/var/www/elowen-plugins/tests/onedriveSync.test.ts:269-313,624-722,724-758`.
- Absolute deletion ceiling, count-bound confirmation, stale/no-refusal confirmation rejection, and local recreation protection: `/var/www/elowen-plugins/tests/onedriveSync.test.ts:917-982`.

Gaps:

- No rendered web test for `OneDriveProjectPanel`, `FolderPicker`, `ConflictsRail`, or `ConfirmDialog` integration.
- No test proving project-level Pause/Resume and Disconnect cannot be submitted twice while pending.
- No end-to-end test proving a 15-second overview refresh cannot lose an active connect choice or cause a stale conflict decision in the browser.
- No plugin-specific integration test for the generic admin config editor proving all five manifest fields are seeded, auto-saved, retried after failure, and not overwritten by a refetch.
- Static/build parity is not exercised here; runtime uses the generated `web/index.js` and `dist/index.js`, so the plugin build should remain part of the normal registry validation path.

## Recommended migration notes

- Keep the five manifest configuration fields on the existing shared 900 ms auto-save path; it already satisfies the canonical persistence, visibility, serialization, validation, and stale-draft requirements.
- Add pending protection to the project-level Pause/Resume action and Disconnect confirmation, matching the workspace-row and Sync now behavior.
- Add a focused rendered UI test suite for connect-root selection, workspace roots, conflicts, bulk-deletion confirmation, and disconnect failure/retry behavior.
- Preserve the current API safeguards: server-derived folder paths, resolved-root containment, per-mirror mutation scope, conditional conflict resolution, remote-folder retention on disconnect, and count-bound deletion confirmation.
- Treat `applyRemoteDeletions` as a reversible behavior setting rather than converting it into an explicit-save form; if product risk labeling is desired, add a manifest risk/help annotation without changing its persistence semantics.
