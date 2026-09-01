# Scope

Audit of the host Projects register and detail rail, project registration/edit/icon/access surfaces under `/var/www/elowen/web/modules/projects`, plus the project-scoped plugin panels rendered by `ProjectDetailTabs`. The currently declared project panels are GitHub, OneDrive, and Sites (`/var/www/elowen-plugins/plugins/{github,onedrive,sites}/elowen-plugin.json`). Read-only project/git data and navigation are included for inventory but are not persistence surfaces.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Projects register and selected-project detail rail | `/var/www/elowen/web/modules/projects/ProjectsView.tsx:221-389` | Register search and selection are local UI state; overview, Git status, branches, and commits are read-only queries. | N/A |
| New project modal | `/var/www/elowen/web/modules/projects/ProjectsView.tsx:147-163,391-423` | Slug/path/notes stay in local state and are sent together by an explicit `Create` mutation; required slug/path gate the button. | Explicit-save justified |
| Edit project modal | `/var/www/elowen/web/modules/projects/ProjectsView.tsx:127-131,165-174,425-472` | Path and notes are local drafts and are sent together by an explicit `Save` mutation; slug is immutable. | Explicit-save justified |
| Project icon picker | `/var/www/elowen/web/modules/projects/ProjectIconPicker.tsx:21-95` | Image choice is local until `Select`; double-click applies immediately; `Remove` and `Select` call `updateProject`. Only mutation disabling and error toast are exposed. | Missing |
| Project access tab | `/var/www/elowen/web/modules/projects/ProjectDetailTabs.tsx:51-110` | `ManageSelectionModal` keeps a local set until `Save changes`, then sends only assignment differences in parallel. | Explicit-save justified |
| Dynamic project-panel host | `/var/www/elowen/web/modules/projects/ProjectDetailTabs.tsx:29-49,114-151` | Plugin-declared panels are loaded dynamically and mounted for the selected project; the host owns no panel draft or persistence itself. | N/A |
| GitHub repository mapping | `/var/www/elowen-plugins/plugins/github/web-src/GitHubProjectPanel.tsx:36-69,104-146` | Four repository fields are edited locally and committed together with explicit `Save mapping`; success invalidates status/repository/PR queries. | Explicit-save justified |
| GitHub publish/PR/review/merge actions | `/var/www/elowen-plugins/plugins/github/web-src/GitHubProjectPanel.tsx:117-152` | Explicit external actions; mutating actions use preview/confirmation where appropriate, and stale 409 state is refreshed. | Explicit-save justified |
| OneDrive project/workspace connection | `/var/www/elowen-plugins/plugins/onedrive/web-src/OneDriveProjectPanel.tsx:250-277,405-458` | Folder selection is local; `Start mirroring` explicitly commits the selected project/workspace scope to an external account. | Explicit-save justified |
| OneDrive pause/sync/disconnect/conflict actions | `/var/www/elowen-plugins/plugins/onedrive/web-src/OneDriveProjectPanel.tsx:30-77,174-245,278-293,460-471` | Explicit operational or potentially destructive actions; controls disable during the relevant mutation and failures are toasted. | Explicit-save justified |
| Sites project register and site detail drawer | `/var/www/elowen-plugins/plugins/sites/web-src/SitesProjectPanel.tsx:9-40`, `/var/www/elowen-plugins/plugins/sites/web-src/SiteDetail.tsx:40-89,107-156` | Site list/detail data is query-backed and read-only until an action is chosen. | N/A |
| Site visibility setting | `/var/www/elowen-plugins/plugins/sites/web-src/SiteDetail.tsx:91-94,158-173` | Non-public dropdown changes issue an immediate `PATCH`; public is gated by a confirmation dialog. Success/error are toasts, with no inline saving/saved/retry state. | Partial |
| Site guest access picker | `/var/www/elowen-plugins/plugins/sites/web-src/SiteDetail.tsx:175-203,285-302` | Guest selection is local until explicit `Save changes`; the mutation writes only the difference sequentially. | Explicit-save justified |
| Site rollback/restart/delete and guest removal | `/var/www/elowen-plugins/plugins/sites/web-src/SiteDetail.tsx:189-195,224-255,276-329` | Explicit operational, destructive, or permission-changing actions with confirmation for deletion; generic mutation success/error feedback is toast-only. | Explicit-save justified |

# Missing or inconsistent auto-save

- The host has a mature auto-save path but none of the ordinary project edits use it. `ProjectsView` has no `useAutoSaveStatus` or `AutoSaveStatus`; create/edit rely on explicit footer buttons and toast callbacks (`ProjectsView.tsx:147-174,458-464`). The explicit edit boundary is defensible for the project path, but notes are bundled into the same transaction and therefore cannot save independently.
- Icon selection is the clearest ordinary setting that is missing auto-save. Clicking an image only changes `selected`; persistence requires `Select`, while double-click uses a separate immediate path (`ProjectIconPicker.tsx:27,46-50,65-74,91-95`). There is no visible saving/saved state or retry action, only disabled buttons while pending and an error toast.
- Project access intentionally follows the shared local-until-save picker contract (`ManageSelectionModal.tsx:135-139`). It shows `Saving` on the footer button, but failures are surfaced only by the caller's toast (`ProjectDetailTabs.tsx:74-85,99-108`); there is no persistent inline error/retry state.
- GitHub mapping has an explicit atomic form, but its `Save mapping` action is not disabled while `saveMap` is pending and the panel exposes no saving/saved/retry indicator (`GitHubProjectPanel.tsx:64-69,146`). Rapid repeated submissions can therefore be initiated even though the mutation refreshes the relevant query groups after success (`:57-67`).
- OneDrive project settings correctly avoid silent auto-commit because they establish an external mirror boundary, but success is silent apart from query refresh. Errors are toast-only and only selected controls expose pending disabling (`OneDriveProjectPanel.tsx:269-293,324-332,449-455`).
- Sites visibility is automatically persisted immediately, so it is closer to the desired model than the host forms, but it is only `Partial`: the generic mutation gives a success toast/error toast (`SiteDetail.tsx:62-69`) rather than visible saving/saved/error+retry state. Repeated changes are not serialized or generation-protected, and the control has no explicit rollback presentation if a request fails.
- The project-panel loader itself handles loading, incompatible API versions, missing registrations, and load failure (`ProjectDetailTabs.tsx:29-49`), but those states are not persistence feedback and should not be counted as auto-save support.

# Legitimate exceptions

- Project creation and project edit combine a path boundary with other fields. Keeping one explicit atomic commit prevents a partially edited root from being registered or applied; this is the same class of multi-field/transactional form that should not be split into independent background writes.
- Project member access and site guest access change authorization. Explicit submission is appropriate for a permission-boundary operation, especially when the picker computes a batch difference rather than one isolated preference.
- GitHub repository mapping is a four-field external repository association and is reasonably kept atomic. GitHub publishing, pull requests, reviews, and merges are externally visible actions; preview/confirmation must remain explicit.
- OneDrive connect, disconnect, sync, deletion confirmation, conflict resolution, and pause/resume affect an external account or potentially destructive file state. Explicit controls and confirmation are justified.
- Site public visibility, rollback, restart, and deletion are externally visible or destructive. Public visibility already has a dedicated confirmation step (`SiteDetail.tsx:91-94,304-313`).
- Read-only register, project overview, git status/history, and site listings have no persistence responsibility.

# Reusable existing pattern

- `useAutoSaveStatus` is the established race-safe controller: it gates the initial server seed, supports validity, bounded debounce, serialized follow-up writes, `flush()` before close/unmount, retry, and `saving`/`saved`/`error` status (`/var/www/elowen/web/lib/useAutoSaveStatus.ts:6-30,45-105`).
- `AutoSaveStatus` provides the corresponding accessible inline feedback and retry affordance (`/var/www/elowen/web/components/ui/AutoSaveStatus.tsx:7-26`).
- `MemoryDetail` is a concrete reference: it autosaves validated edits, flushes before leaving edit mode, and renders the status beside the completion action (`/var/www/elowen/web/modules/memory/MemoryDetail.tsx:77-92,118-123`).
- `ManageSelectionModal` is the correct shared primitive for justified batch/permission edits: it deliberately keeps selection local until save, keeps the modal open when an async save rejects, and labels the pending button (`/var/www/elowen/web/components/ui/ManageSelectionModal.tsx:135-139,189-199,293-301`).

# Tests and gaps

- Host coverage verifies register/detail rendering, access-tab opening, edit draft preservation, directory browsing, and removal race behavior (`/var/www/elowen/web/tests/modules/projects/ProjectsView.test.tsx:30-63,161-212,214-257`). It does not verify successful project create/update/icon/access persistence, pending/saved/error feedback, or retry behavior.
- `ProjectDetailTabs` coverage only verifies mounting a plugin-declared project panel and tab selection (`/var/www/elowen/web/tests/modules/projects/ProjectDetailTabs.test.tsx:26-48`).
- Mutation coverage tests assignment direction and route selection, but not create/update/icon mutations or their invalidation behavior (`/var/www/elowen/web/tests/lib/mutations.test.tsx:54-74`).
- GitHub UI coverage opens the mapping form but does not submit it (`/var/www/elowen-plugins/tests/github-ui.test.tsx:169-180`); its external-action test does cover stale confirmation refresh (`:138-167`).
- Sites UI coverage verifies immediate visibility persistence, public confirmation, and guest-picker difference writes (`/var/www/elowen-plugins/tests/sites-ui.test.tsx:130-189`), but does not assert saving/error/retry feedback or rapid-change ordering.
- OneDrive tests currently cover manifest/string invariants rather than project-panel interaction or mutation feedback (`/var/www/elowen-plugins/tests/onedriveApi.test.ts:143-170`).

# Recommended migration notes

- Keep explicit commits for project path/root changes, authorization changes, and external/destructive operations. Add consistent inline pending/success/error+retry feedback to those forms rather than treating a toast as the only acknowledgement.
- Convert the icon picker to one canonical immediate-save path on selection, or explicitly adopt `useAutoSaveStatus` for the selected icon and remove the separate double-click behavior. The current two commit paths are inconsistent.
- Preserve GitHub mapping as an atomic explicit form unless the backend can accept field-level updates safely; at minimum disable repeated submission and expose mutation status/retry.
- Keep Sites non-public visibility immediate, but use a dedicated visible save status and serialize or generation-protect rapid changes. Retain the public confirmation gate.
- Add focused tests for host create/update/icon/access success and failure, status/retry rendering, GitHub mapping submission/pending behavior, OneDrive connect failure feedback, and Sites rapid visibility changes.
