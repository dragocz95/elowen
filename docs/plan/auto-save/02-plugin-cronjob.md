# Scope

Audit of the registry `cronjob` plugin at `/var/www/elowen-plugins/plugins/cronjob`, covering:

- the Automation jobs register on both the Settings deck and direct plugin page;
- row drafts and the selected-job detail drawer/rail;
- schedule builder modes, active-hours controls, toggles, selectors, model and destination pickers;
- instance plugin configuration rendered by the host's generic plugin-config workspace;
- job/config persistence APIs and other writers (`CronAdd`, `ScheduleWakeup`, `CronRemove`, scheduler state);
- loading, error, retry, stale-refresh, concurrent-write, and destructive-action behavior.

The plugin has one custom browser surface (`JobsSettings`) and one host-rendered config surface from `configSchema`. The built `web/index.js` mirrors `web-src`; findings below cite the source of truth.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Automation jobs in Settings deck | `/var/www/elowen-plugins/plugins/cronjob/web-src/index.tsx:11-16`; `JobsSettings.tsx:572-769` | Server query via `useCronJobs`; each row owns a debounced `useAutoSaveStatus` PUT; status and Retry remain in the table row even when the rail closes. | Compliant |
| Direct Automation plugin page (`/p/cronjob`, including dashboard link) | `index.tsx:11-16`; host route `/var/www/elowen/web/app/p/[plugin]/[[...rest]]/page.tsx:95-143`; dashboard link `/var/www/elowen/web/modules/dashboard/MetricsTile.tsx:48-80` | Same `JobsSettings` component and same per-row PUT path; `ownsPageFrame` prevents a duplicate host frame. Dashboard is read-only and links to the register. | Compliant |
| New and existing row drafts | `JobsSettings.tsx:246-321,323-336,582-633` | Draft is local per row; seed is not saved; valid edits debounce 900 ms; invalid drafts hold saves; save callback strips read-only `owner`; server refresh is adopted only when the row is clean. New rows remain local until a valid PUT succeeds. | Compliant |
| Selected job detail rail/drawer | `JobsSettings.tsx:454-565` | All editable text, toggles, selectors, builder changes, model/destination changes, and owner changes call `patch`, which feeds the row autosave. The component remains mounted while the rail closes, preserving unsaved state and row-level retry. | Compliant |
| Schedule builder: interval/daily/weekly/advanced | `JobsSettings.tsx:60-185`; `scheduleBuilder.ts:15-50` | Builder emits canonical strings into the same draft. Advanced mode preserves unsupported/raw values until the user edits or chooses another mode; UI validity uses host `utils.isValidSchedule`. | Compliant |
| Active-hours control | `JobsSettings.tsx:187-243`; daemon behavior `/var/www/elowen-plugins/plugins/cronjob/index.mjs:373-381` | Off/window/legacy selection updates the same draft. Legacy values are displayed and preserved until the user explicitly selects another mode; generated values are bounded to `0..23` and support overnight ranges. | Compliant |
| Run now action | `JobsSettings.tsx:338-352,543-550`; daemon route `index.mjs:1176-1194` | Explicit immediate POST, disabled for unsaved/invalid/pending/one-shot rows; success is acknowledged and a short refresh exposes scheduler state. | Explicit-save justified |
| Delete job action | `JobsSettings.tsx:354-365,557-564`; daemon route `index.mjs:1197-1218` | Explicit confirmation followed by idempotent DELETE. Pending PUTs are awaited; unsaved new rows are not deleted remotely; failed DELETE restores the row's saving eligibility and shows an error. | Explicit-save justified |
| Generic instance plugin configuration (Scheduler and Per-account limits) | Manifest `/var/www/elowen-plugins/plugins/cronjob/elowen-plugin.json:42-151`; host editor `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:632-1009`; draft `/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-112`; workspace `/var/www/elowen/web/modules/settings/PluginDetail.tsx:58-65,102-152` | All number fields and sections are rendered by the shared config editor. Changes autosave after 900 ms through a serialized full-snapshot PATCH; the workspace toolbar exposes Saving/Saved/Error+Retry. | Partial |
| Jobs REST persistence API | Client `/var/www/elowen/web/lib/elowenClient.ts:167-172`; query/mutations `/var/www/elowen/web/lib/queries.ts:301-304`, `/var/www/elowen/web/lib/mutations.ts:189-199`; daemon `index.mjs:985-1173` | GET lists visible jobs; PUT upserts exactly one job and preserves scheduler-owned fields; writes are atomic and read-modify-write; DELETE is idempotent; POST run is separate from editing. | Compliant |
| Tool and scheduler writers/readers | `index.mjs:812-825,1222-1275,1277-1315,1318-1360,1362-1373` | `CronAdd`/`ScheduleWakeup` append jobs, `CronRemove` deletes after visibility checks, scheduler patches runtime fields, and pending deliveries use a separate bounded atomic store. These are not form edits and have no autosave UI. | N/A |
| Read-only dashboard next-run tile | `/var/www/elowen/web/modules/dashboard/MetricsTile.tsx:48-80`; query `/var/www/elowen/web/lib/queries.ts:301-304` | Fetches jobs only when the caller is an admin and computes/display links to the Automation page; no mutation surface. | N/A |

# Missing or inconsistent auto-save

1. **Pending live activation is lost in the generic config UI.** The config API explicitly distinguishes durable persistence from delayed runtime activation: `/var/www/elowen/src/api/routes/plugins/index.ts:116-138,500-518` returns `202 { ok: true, pending: true }` when reload is deferred or fails after persistence. `usePluginConfigDraft` awaits the response but discards its `pending` field (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:72-80`), so `AutoSaveStatus` can say only `Saved`; it cannot say that the cron scheduler will apply the change shortly. This is a UX/status gap, not a durability failure.

2. **Invalid row drafts can retain a misleading previous `Saved` status.** Cron rows correctly pass `savable: isSavable(draft)` (`JobsSettings.tsx:300-321`), and the shared hook cancels pending saves for invalid values (`/var/www/elowen/web/lib/useAutoSaveStatus.ts:70-83`). It does not reset a prior terminal status, however. After a previously saved row is edited to an invalid schedule or blank required field, the row may continue showing `Saved` while the current draft is intentionally not persisted. The shared hook's documented status semantics should either explicitly mean “last successful save” or expose a distinct dirty/invalid state; cron's row-level status makes the ambiguity visible.

3. **No version/ETag conflict protection exists for external concurrent edits.** Local server refetches are guarded by `dirty.current` and `serverCopy` (`JobsSettings.tsx:323-331`), and the API safely updates one job instead of replacing the whole list (`index.mjs:985-1005,1112-1173`). A scheduler/tool/second browser writer can still change the same user-owned fields while a row is dirty; the next autosave has no revision check and overwrites that change. This is a concurrency gap rather than a stale-query bug. If concurrent editing matters, add a revision/updated-at precondition or surface a conflict instead of silently winning last-write-wins.

4. **The plugin lacks focused behavioral tests for its custom autosave lifecycle.** The shared hook has strong race/unmount tests, but there is no cronjob-specific test covering a new row becoming valid, drawer close with a pending edit, retry after PUT failure, delete racing an in-flight PUT, invalid-to-valid recovery, or server refresh during a dirty row. Existing e2e coverage measures register geometry and row opening, not persistence interactions.

# Legitimate exceptions

- **Run now** is an explicit immediate operation, not an edit to persist. It is correctly disabled until the row is persisted and clean, and one-shot wake-ups cannot be manually run (`JobsSettings.tsx:338-350`; `index.mjs:1187-1193`).
- **Delete** must remain explicit and confirmed because it is destructive and irreversible. The skill also requires explicit confirmation and forbids batch deletion (`skills/elowen-scheduling.md:48-51`).
- **Advanced cron values and legacy active-hours values** are intentionally preserved rather than normalized or silently discarded. Choosing a builder mode is the user's explicit conversion point (`JobsSettings.tsx:164-181,191-241`).
- **Secrets are not present in this plugin manifest**, but the generic config system's write-only secret behavior is appropriate where other registry plugins use it (`/var/www/elowen/src/api/routes/plugins/index.ts:62-100`; `/var/www/elowen/web/lib/usePluginConfigDraft.ts:7-18`).
- **Scheduler/tool writes are not autosave candidates.** They are immediate domain operations and use the plugin's atomic JSON stores. `CronAdd` and `ScheduleWakeup` persist immediately; `CronRemove` is intentionally destructive (`index.mjs:1222-1275,1277-1315,1342-1360`).

# Reusable existing pattern

Use the existing shared pattern already used by cron rows and the host config editor:

- `useAutoSaveStatus` with a 900 ms debounce, a `savable` gate, serialized follow-up writes, unmount `flush`, and Retry (`/var/www/elowen/web/lib/useAutoSaveStatus.ts:6-30,45-105`).
- A local draft seeded once from the server, with refetch protection while dirty (`JobsSettings.tsx:283-331`; `/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-80`).
- A visible `AutoSaveStatus` at the owning surface, with `role="status"` for saving/saved and `role="alert"` plus Retry on failure (`/var/www/elowen/web/components/ui/AutoSaveStatus.tsx:7-27`).
- One-record mutation for shared collections: `saveCronJob` PUTs a single job and invalidates the list (`/var/www/elowen/web/lib/elowenClient.ts:167-172`; `/var/www/elowen/web/lib/mutations.ts:189-199`).
- Server-side validation and atomic persistence remain authoritative: cron PUT validation is at `index.mjs:991-1027`, and `writeJsonAtomic` is used by `JobStore.save` at `index.mjs:812-825`.

# Tests and gaps

- **Shared autosave unit coverage:** `/var/www/elowen/web/tests/lib/useAutoSaveStatus.test.tsx:6-102` covers seed suppression, debounce, status transitions, retry, unmount flush, in-flight unmount, Activity hide/show, and stale-response ordering.
- **Shared generic config coverage:** `/var/www/elowen/web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105` covers invalid JSON, write-only secrets, immediate commit failure/success, pending activation result, and serialized snapshots. `/var/www/elowen/web/tests/modules/settings/PluginConfigEditor.test.tsx:81-122` covers confirmation and persistence failure for destructive modal-backed config edits.
- **Schedule contract coverage:** `/var/www/elowen/tests/contract/cronParity.test.ts:8-44` checks web validation and next-run behavior against the shared grammar corpus.
- **Browser/layout coverage:** `/var/www/elowen/web/tests/e2e/specs/register.rowopen.e2e.ts:30-34,111-166` includes `cronjob` in real-browser row geometry/opening checks; `/var/www/elowen/web/tests/e2e/specs/plugin.viewport.e2e.ts:18-21,90-105,253-302` includes registry cronjob page layout and narrow-width identity checks. The fake daemon only serves a GET fixture for jobs (`/var/www/elowen/web/tests/e2e/fake-daemon/handlers/pluginSurfaces.ts:73-84`).
- **Config API coverage:** `/var/www/elowen/tests/api/pluginRoutes.test.ts:339-379` verifies immediate, deferred, post-persistence reload failure, and pre-persistence failure semantics generically.
- **Gaps:** no focused cronjob UI/API integration tests for PUT validation, row draft lifecycle, drawer close/flush, Retry rendering after a cron PUT failure, delete/PUT ordering, one-shot edit preservation, owner/destination permission combinations, or pending activation presentation. There are also no tests pinning the `Saved`-while-currently-invalid status interpretation or external concurrent-edit behavior.

# Recommended migration notes

- Preserve the current per-row autosave architecture; do not replace it with whole-list saves. The one-job PUT boundary is specifically designed to avoid deleting jobs created by the scheduler or brain tools.
- Add a focused cronjob UI test suite around the acceptance path: add row → fill required fields → wait for PUT → close/reopen rail → edit all controls → force PUT failure → Retry → delete while a PUT is in flight.
- Decide and document the status contract for invalid drafts. Prefer a distinct dirty/invalid presentation, or explicitly label the existing `Saved` state as the last persisted snapshot rather than the current draft.
- Propagate `pending` from the generic plugin config draft into the shared status surface, so durable config saves distinguish “saved and active” from “saved; activation pending.” The server contract and generic tests already exist.
- If same-job edits from tools, another tab, or scheduler-adjacent writers must not overwrite user changes, add a server revision/precondition. Otherwise document last-write-wins as the deliberate policy and test it.
- Keep Run now and Delete explicit; they are domain actions, not autosave candidates. Keep confirmation for Delete and retain the existing in-flight ordering safeguards.
