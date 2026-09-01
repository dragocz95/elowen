# Scope

Audit of the host Users register and selected-user detail rail under `web/modules/users`, including account creation, identity/profile edits, role and account actions, project access, model permissions, plugin grants, tool access, and plugin-defined user panels. Read-only listing, search, statistics, impersonation, and loading/error states were inspected where they affect persistence expectations.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Users register, search, row selection | `web/modules/users/UsersView.tsx:30-47,108-117,182-266` | Query-backed directory; search and selected row are local UI state only. No persisted edit. | N/A |
| Add-user modal | `web/modules/users/UsersView.tsx:268-285` | Username/password remain local until an explicit `Create` submit; `useCreateUser` POSTs and invalidates `['users']` (`web/lib/mutations.ts:55-57`). | Explicit-save justified |
| Delete account | `web/modules/users/UsersView.tsx:68-73,289-296` | Explicit confirmation followed by DELETE; the list is invalidated after success (`web/lib/mutations.ts:59-61`). | Explicit-save justified |
| Administrator role change | `web/modules/users/UsersView.tsx:90-102,297-310` | Explicit confirmation, serialized by `rolePendingRef`, then PATCH `{ is_admin }`; errors remain actionable through a toast and the dialog stays open while pending. | Explicit-save justified |
| Impersonation | `web/modules/users/UsersView.tsx:104-105,119-165` | Immediate session action; no user data is persisted by this surface. | N/A |
| User identity/profile (display name and username) | `web/modules/users/UserDetailPane.tsx:257-305` | Local two-field draft, explicit `Save`, PATCH of both fields, then Users-query invalidation through `useUpdateUser` (`web/lib/mutations.ts:63-69`). Username collision is mapped to a specific error. | Partial |
| Project access | `web/modules/users/UserDetailPane.tsx:34-91` | `ManageSelectionModal` stages a local set and explicit `Save`; changed projects are sent as separate POST/DELETE calls in `Promise.all`. Each successful call invalidates the user-project query (`web/lib/mutations.ts:327-344`). | Missing |
| Allowed model grants | `web/modules/users/UserDetailPane.tsx:95-195` | Local modal selection; explicit `Save` PATCHes the complete `allowed_execs` array (`:161-168`). The modal closes only after the request resolves. | Missing |
| Granted plugin permissions | `web/modules/users/UserDetailPane.tsx:198-254` | Local modal selection; explicit `Save` PATCHes the complete `granted_plugins` array (`:220-228`). | Missing |
| Tool access grants/denials | `web/modules/users/ToolPills.tsx:29-131` | Local modal selection; explicit `Save` computes a grant-preserving patch for `allowed_tools` and possibly `disabled_tools`, then PATCHes it (`:66-103`). The user-tools query is invalidated only after success. | Missing |
| Plugin-defined user panels | `web/modules/users/PluginUserPanels.tsx:13-49`; contract `packages/plugin-ui-kit/index.d.ts:112-118` | Host dynamically mounts extension components and passes `{ plugin, panelId, user, surface: 'user' }`. Persistence behavior is opaque to the host; the user-panel contract has no host save-status channel. | N/A |

# Missing or inconsistent auto-save

- The four grant editors use the shared modal in staged-selection mode. `ManageSelectionModal` explicitly documents that selection is local until `Save changes` (`web/components/ui/ManageSelectionModal.tsx:135-139`), seeds local state on open (`:140-155`), and closes only after `onSave` resolves (`:189-199`). This is not automatic persistence.
- The modal exposes only a button-level `Saving` state and a generic count/footer (`web/components/ui/ManageSelectionModal.tsx:280-300`). There is no persistent `saving → saved` status, no dedicated retry affordance, and closing/cancelling discards the unsaved selection. Error handling keeps the modal open, but it is toast-based rather than the canonical visible save feedback.
- Model and plugin saves replace the whole grant array from a modal snapshot (`UserDetailPane.tsx:147-168,211-228`). Tool access is more careful about preserving unavailable and legacy grants (`ToolPills.tsx:70-103`), but it still submits only on explicit Save. A server refresh or another admin's change while the modal is open can be overwritten by the stale local snapshot.
- Project access is especially inconsistent: the UI presents a batch selection, but persistence is multiple independent requests (`UserDetailPane.tsx:54-65`; `web/lib/elowenClient.ts:388-392`). `Promise.all` is not a transaction; a partial failure can leave some assignments applied while the modal remains open, with no explicit reconciliation or saved baseline.
- Identity editing has no autosave controller, validity baseline, or stale-response protection. State is initialized once (`UserDetailPane.tsx:264-268`) and only reseeded when the pencil action starts (`:269-274`). The selected rail renders `UserDetailPane` without an identity key (`web/modules/users/UsersView.tsx:261`), and `IdentityHeader` has no effect to reseed when `user` changes. Switching users while editing can therefore retain the previous user's draft; a refetch during editing can also be overwritten because `save()` sends both fields (`UserDetailPane.tsx:276-282`).
- The existing `useUpdateUser` invalidates `['users']`, `['me']`, and project summaries (`web/lib/mutations.ts:63-69`), but this does not reconcile local modal drafts or establish a per-user server baseline. The refresh is therefore useful after a completed save but insufficient for concurrent edits.
- Plugin panels can contain arbitrary profile or grant editors, but the host cannot verify whether they autosave or expose failures. Unlike the page/deck plugin contract, `PluginUserPanelProps` has no `onSaveState` callback (`packages/plugin-ui-kit/index.d.ts:112-118`), so the host cannot provide canonical feedback for these contextual editors.

# Legitimate exceptions

- Creating an account should remain an explicit atomic action: it includes a password secret and a unique login credential, and it is inappropriate to create a partially typed account. The current form also preserves its draft after a rejected POST (`web/modules/users/UsersView.tsx:75-87`; regression test `web/tests/modules/users/UsersView.test.tsx:169-185`).
- Account deletion is destructive and correctly requires confirmation (`UsersView.tsx:289-296`).
- Administrator promotion/demotion is a privileged access change and correctly requires confirmation, including a self-demotion warning (`UsersView.tsx:297-310`; test `UsersView.test.tsx:122-167`).
- Username changes affect a login credential and need explicit deliberate validation for collisions (`UserDetailPane.tsx:257-282`). A separate display-name-only editor would not have the same constraint; combining it with the credential field is why the current identity surface is only Partial rather than fully compliant.
- Project selection could justify an explicit review-and-apply step if the product requires multi-change permission review, but the current API is not atomic. Keeping this exception should require an actual transactional/batch boundary or an explicitly accepted partial-application model.
- Impersonation and read-only plugin panels are not persistence surfaces. Plugin-owned panels remain the extension owner's responsibility unless the host contract is expanded to require/report save behavior.

# Reusable existing pattern

- `web/lib/useAutoSaveStatus.ts:4-30,45-105` is the established controller: validated readiness, bounded debounce, serialized latest-state writes, stale-response-safe status, `flush()` on close/unmount, and `retry()` after failure.
- `web/components/ui/AutoSaveStatus.tsx:7-27` is the canonical visible feedback for saving, saved, and error/retry states.
- `web/modules/memory/MemoryDetail.tsx:77-92,118-123` demonstrates a detail editor with no Save button, validation, flush-before-close, and visible status.
- `web/modules/settings/ContextWindowModal.tsx:12-15,26-52` demonstrates the same pattern inside a modal while retaining an explicit Done/clear action that drives the autosave rather than performing the persistence itself.
- For user grants, the controller should be keyed/seeding-aware per selected user and save the latest validated grant snapshot. Existing query invalidation can remain the post-save reconciliation mechanism, but it must not overwrite a dirty local draft.

# Tests and gaps

Existing focused coverage is useful but currently proves explicit-save behavior rather than autosave:

- `web/tests/modules/users/UserDetailPane.test.tsx:119-137` verifies model grants are PATCHed only after clicking `Save changes`.
- `UserDetailPane.test.tsx:162-186` verifies project changes are diffed into separate assign/unassign calls.
- `UserDetailPane.test.tsx:214-260` verifies explicit identity Save, collision feedback, draft retention on error, and empty-username validation.
- `web/tests/modules/users/ToolPills.test.tsx:111-165` covers explicit tool Save, deny-list preservation, unavailable-tool preservation, and wildcard conversion.
- `web/tests/modules/users/UsersView.test.tsx:62-91,93-185` covers explicit model Save, destructive confirmation, role confirmation, and create-error draft retention.
- The shared autosave controller is independently covered for debounce, status, retry, unmount flush, Activity hide/show, and stale responses in `web/tests/lib/useAutoSaveStatus.test.tsx:6-102`.

Missing user-module coverage includes:

- autosave trigger, debounce, `saving/saved/error`, retry, and flush-on-close for identity and each grant type;
- protection against server refetches while a draft is dirty;
- switching the selected user while an identity or grant editor is open;
- concurrent/rapid grant changes and stale response ordering;
- partial project-assignment failure and reconciliation after one request in the batch succeeds;
- plugin user-panel persistence and save-status reporting;
- explicit confirmation that create/delete/role actions remain confirmation-gated after any autosave migration.

# Recommended migration notes

- Move ordinary display-name editing and the four grant surfaces to `useAutoSaveStatus` with a server-seeded baseline, validation, serialized latest-state writes, `flush()` on close, and `AutoSaveStatus` rendered in the relevant detail block or drawer header.
- Keep username changes deliberately explicit, or split username from display-name editing so only the credential-bearing field retains explicit Save. In either case, key the detail editor by user id and track baseline/sent values so refetches cannot clobber dirty input or write one user's draft into another user's drawer.
- For model, plugin, and tool grants, preserve the existing server-side patch semantics and tool-grant safety rules while avoiding whole-array writes from stale modal snapshots. If the modal remains staged, it should at minimum use the canonical save-status/retry pattern; that would still not satisfy automatic persistence.
- Decide the project-access boundary explicitly: add a transactional batch API before treating a staged multi-project Save as a justified exception, or autosave individual toggles with clear partial-failure reconciliation and latest-state protection.
- Extend the plugin user-panel contract with a save-status callback or require plugin panels to render their own canonical autosave feedback; the host currently has no way to audit or surface their persistence state.
