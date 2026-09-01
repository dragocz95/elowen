# Scope

Audited the registry `sites` plugin at `/var/www/elowen-plugins/plugins/sites`, including its manifest-driven instance configuration, main Sites page, Project panel, shared site-detail drawer, sign-in handoff page, plugin lifecycle controls, and all browser-facing persistence APIs. Host behavior was checked in `/var/www/elowen` because `configSchema` and plugin lifecycle writes are rendered and persisted by the host.

The plugin has one web bundle and one shared detail implementation: `web-src/index.tsx:7-13` registers the main page, `enter` page, and Project panel; `SitesProjectPanel.tsx:32-40` reuses `SitesRegister` and `SiteDetail`.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Instance-wide Sites configuration | `/var/www/elowen-plugins/plugins/sites/elowen-plugin.json:47-203`; host `/var/www/elowen/web/modules/settings/PluginDetail.tsx:58-65,94-140,148-153`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:632-636,660-819`; `/var/www/elowen/web/lib/usePluginConfigDraft.ts:43-112` | All 13 declared value fields (visibility, public access, publisher policy, runtime limits, site limits, access TTL, and contact email) are rendered by the generic schema editor. Changes debounce for 900 ms, serialize full-snapshot writes, validate JSON/number/timezone/token values, show saving/saved/error, and expose retry; host reseeding is guarded against stale refetches. | **Compliant** |
| Plugin enable/disable | `/var/www/elowen/web/modules/settings/PluginsSection.tsx:81-140,194-217,271-315`; `/var/www/elowen/src/api/routes/plugins/index.ts:520-537` | Immediate mutation of `config.plugins.enabled`, with busy state, consent gate, optimistic rollback, refetch, and success/error toast. This is an action rather than a draft form. | **Compliant** |
| Plugin install/update/restore/uninstall | `/var/www/elowen/web/modules/settings/PluginsSection.tsx:147-190,274-303,405-414`; `/var/www/elowen/src/api/routes/plugins/index.ts:324-357,545-578` | Immediate registry operations with busy state, confirmation for removal, pending 202 handling, and success/error toasts. Uninstall/removal is intentionally explicit and destructive. | **Explicit-save justified** |
| Sites main register and toolbar | `/var/www/elowen-plugins/plugins/sites/web-src/SitesPage.tsx:156-175,225-250,260-320` | Read-only site query via `GET /plugins/sites/api/sites` (`:165-168`). Section/visibility/status filters use host persistent state (`:170-172`); search is intentionally transient (`:173-175`). No domain edit is hidden behind a Save button. | **N/A** |
| Project Sites panel | `/var/www/elowen-plugins/plugins/sites/web-src/SitesProjectPanel.tsx:9-28,30-43` | Read-only query using the shared sites-list key and a Project filter. Loading/error states provide retry; edits happen only after opening the shared drawer. | **N/A** |
| Site-detail visibility selector | `/var/www/elowen-plugins/plugins/sites/web-src/SiteDetail.tsx:40-69,91-94,158-173`; `/var/www/elowen-plugins/plugins/sites/src/api.ts:166-170,201-226` | Non-public changes issue an immediate `PATCH /api/site/<id>`; success invalidates detail/list and shows `Saved`, errors show an error toast. Public visibility is held behind a confirmation dialog (`SiteDetail.tsx:304-313`). | **Partial** |
| Named-guest picker and remove actions | `/var/www/elowen-plugins/plugins/sites/web-src/SiteDetail.tsx:71-86,175-203,285-302`; `/var/www/elowen-plugins/plugins/sites/src/api.ts:173-179,228-237` | The picker intentionally uses an explicit `Save changes` step and sends only add/remove differences. Writes are sequential, show a saving state in the picker, invalidate on success, and toast errors. Individual removal is immediate. | **Explicit-save justified** |
| Release rollback and runtime restart | `/var/www/elowen-plugins/plugins/sites/web-src/SiteDetail.tsx:206-241,243-273`; `/var/www/elowen-plugins/plugins/sites/src/api.ts:181-197` | Explicit immediate POST actions with disabled pending buttons, success toast, error toast, and detail/list invalidation. These are operational commands, not draft settings. | **Explicit-save justified** |
| Site deletion | `/var/www/elowen-plugins/plugins/sites/web-src/SiteDetail.tsx:276-283,316-328`; `/var/www/elowen-plugins/plugins/sites/src/api.ts:166-171`; `/var/www/elowen-plugins/plugins/sites/src/index.ts:108-128` | Destructive action requires confirmation, then issues `DELETE`; backend marks deletion durably before stopping processes/removing files and retries reconciliation after failure. | **Explicit-save justified** |
| Published-site sign-in handoff | `/var/www/elowen-plugins/plugins/sites/web-src/EnterPage.tsx:14-43,55-59`; `/var/www/elowen-plugins/plugins/sites/src/api.ts:239-272` | One-time ticket is an authentication handshake, not user-editable state. It uses immediate POST and a form POST to the site origin; no draft or Save control is appropriate. | **N/A** |
| Sites browser API reads | `/var/www/elowen-plugins/plugins/sites/src/index.ts:240-243`; `/var/www/elowen-plugins/plugins/sites/src/api.ts:118-163,275-288` | `GET /sites`, `GET /site/<id>`, and `GET /directory` are read-only; access is checked server-side and guests are withheld from non-managers. | **N/A** |
| Sites browser API mutations | `/var/www/elowen-plugins/plugins/sites/src/api.ts:166-237`; `/var/www/elowen-plugins/plugins/sites/src/store.ts:329-413` | PATCH site fields, POST/DELETE members, POST rollback/restart, and DELETE site persist immediately through the plugin store. Visibility changes bump access generation; member add/remove and deletion enforce ownership/admin checks. | **Partial** |
| Plugin config persistence API | `/var/www/elowen/src/api/routes/plugins/index.ts:500-518`; `/var/www/elowen/src/plugins/manifest.ts:12-35`; `/var/www/elowen/web/lib/mutations.ts:283-288` | Host validates and applies the whole config snapshot, persists before hot reload, and returns `202 pending` when activation is deferred. UI invalidates plugin detail/list/commands after success. | **Compliant** |

# Missing or inconsistent auto-save

- **Site visibility lacks the shared save-status contract.** `SiteDetail` uses a generic mutation and only emits a success/error toast (`SiteDetail.tsx:62-69`); the selector itself is not disabled while pending (`:160-167`) and has no retry action. The host pattern provides `saving`, `saved`, `error`, and `retry` through `useAutoSaveStatus` (`/var/www/elowen/web/lib/useAutoSaveStatus.ts:4-18,45-67,85-105`) and `AutoSaveStatus` (`/var/www/elowen/web/components/ui/AutoSaveStatus.tsx:7-27`). Rapid visibility changes are not serialized in this drawer.
- **Guest “Save changes” is justified as a multi-select commit, but the API is not atomic.** `saveGuests` performs multiple independent requests (`SiteDetail.tsx:74-83`). If a later add/remove fails, earlier changes remain durable while the picker reports only an error (`:84-86`); there is no compensating refresh or retry of the intended full set. The backend exposes only per-member writes (`api.ts:173-179,228-237`), so the UI cannot currently guarantee all-or-nothing persistence.
- **Mutation failures do not provide drawer-level retry.** Visibility, member removal, rollback, restart, and delete all share the toast-only error path (`SiteDetail.tsx:62-69`); the user must repeat the action manually. This is less robust than the shared plugin-config editor, where retry is explicit and status is persistent in the toolbar.
- **No focused API regression coverage was found for these behaviors.** `/var/www/elowen-plugins/tests/sites-ui.test.tsx` covers rendering, dropdown selection, public confirmation, and the guest picker (`:88-190`), but does not cover mutation failure, pending status, retry, stale responses, or partial guest-write failure. The repository search found no dedicated Sites API/store test file.
- **The config contract has a typing inconsistency, not an autosave failure.** The manifest declares `contactEmail` (`elowen-plugin.json:199-203`), but `SitesConfig`/`resolveConfig` omit it (`src/config.ts:3-31,69-96`); the gateway nevertheless reads the persisted raw plugin config directly (`src/gateway.ts:186-189`). The value is therefore consumed after autosave, but the typed config boundary is incomplete and should be cleaned up separately.

# Legitimate exceptions

- Public visibility requires an explicit confirmation because it changes access from authenticated/selected users to anyone with the address (`SiteDetail.tsx:91-94,304-313`; manifest warning at `elowen-plugin.json:286-288`).
- Named guest selection is a multi-step atomic-intent form: local selection should not write on every click, and the shared `ManageSelectionModal` explicitly returns the whole set (`SiteDetail.tsx:285-302`). The current delta API is the remaining atomicity gap, not a reason to remove the confirmation step.
- Rollback, runtime restart, and deletion are explicit operational/destructive actions, not ordinary field edits (`SiteDetail.tsx:206-241,243-283,316-328`).
- Site publishing itself is agent/tool-driven and intentionally not exposed as a browser Save flow. `SitePublish` creates a release and changes the live release in a transaction (`/var/www/elowen-plugins/plugins/sites/src/tools.ts:287-395`); treating publish as autosave would blur a release boundary.
- The sign-in ticket and session secret are credentials/handshake state and must remain immediate, single-use, or vault-backed (`api.ts:239-272`; `index.ts:32-53`).

# Reusable existing pattern

Use the host plugin-config pattern as the reference implementation:

- `usePluginConfigDraft` seeds once, debounces at 900 ms, serializes full snapshots, validates before saving, prevents stale refetches from overwriting drafts, flushes on teardown, and offers retry (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-112`).
- `PluginConfigEditor` renders every manifest field through shared controls and modal/picker primitives (`/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:632-819`).
- `PluginDetail` places `AutoSaveStatus` beside the workspace tabs (`/var/www/elowen/web/modules/settings/PluginDetail.tsx:102-112`), so status remains visible across setup/behavior/advanced config surfaces.
- The Sites drawer already uses the correct shared primitives for selection, confirmation, loading, and error states (`SiteDetail.tsx:158-173,285-329`); the missing piece is a small serialized mutation/status owner for ordinary access edits, not a second settings framework.

# Tests and gaps

- Passing focused UI evidence: `/var/www/elowen-plugins/tests/sites-ui.test.tsx:88-190` verifies the register/filter layout, avatar/name rendering, unified drawer contents, dropdown visibility PATCH, public confirmation, and guest-difference writes.
- Passing host autosave evidence: `/var/www/elowen/web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105` verifies invalid JSON handling, write-only secrets, immediate commit semantics, pending activation, serialized full-snapshot saves, and final saved status.
- Missing Sites-specific checks: mutation error state and retry; disabled/pending visibility control; out-of-order visibility writes; guest partial failure/reconciliation; deletion failure/retry; and backend API authorization/validation/store transactions. The current UI tests do not exercise those paths.

# Recommended migration notes

1. Keep instance plugin configuration on the existing host schema-driven autosave path; it is already compliant and handles the manifest’s full field set.
2. Add a drawer-local serialized access mutation controller for visibility and member actions, exposing `saving/saved/error/retry` in the detail rail or block. Do not debounce public confirmation, rollback, restart, or delete.
3. Prefer one backend operation that replaces a site’s guest set transactionally, or add explicit reconciliation after any delta failure before closing/reporting the picker save.
4. Add focused UI/API tests for failure, retry, stale responses, and partial guest writes before changing drawer persistence behavior.
