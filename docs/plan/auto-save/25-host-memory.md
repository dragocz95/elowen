# Scope

Audit of the host Memory surfaces and their adjacent settings: the Memory list drawers, memory editor, category manager, memory retention policy, categorization provider settings, maintenance actions, and bulk actions. Authoritative code is under `/var/www/elowen/web`; this report does not propose implementation changes.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Memory detail drawer/editor | `web/modules/memory/MemoryView.tsx:491-503`; `web/modules/memory/MemoryDetail.tsx:37-46, 77-103, 118-168` | Body, kind, importance, and category are held in a keyed draft and persisted through `useAutoSaveStatus`; the controller debounces, serializes writes, flushes on Done/unmount, and exposes retry. Empty body is held back as invalid. The drawer has an inline `Saving…`/`Saved`/`Save failed + Retry` indicator. | **Compliant** |
| New memory modal | `web/modules/memory/MemoryView.tsx:523-524, 673-743` | Explicit `Create` submits one POST. Category is then written by a separate audited PUT (`:694-701`); the button is disabled while either write is pending and failures are toasted. There is no draft autosave or retry status. | **Explicit-save justified** — creation is a multi-field operation and category assignment is a separate audited write; preserve atomic user intent rather than creating partial records while typing. |
| Merge modal | `web/modules/memory/MemoryView.tsx:525-531, 746-781`; `web/lib/elowenClient.ts:419` | Explicit `Merge` submits selected IDs plus edited body; the server creates a new memory and soft-deletes the sources. | **Explicit-save justified** — destructive, multi-record operation. |
| Category manager and create/edit modal | `web/modules/memory/CategoryManager.tsx:22-70, 74-136, 138-227` | Name, description, project scope, color, and icon are a local multi-field draft. `Create`/`Save` sends one POST/PATCH only after validation; pending disables the button and errors are shown as toasts. Icon suggestion is debounced, but it is only a suggestion and does not persist the category. | **Explicit-save justified** — a category is an atomic multi-field record, and committing only after the user finishes avoids storing incomplete names/scopes. The save feedback is weaker than the shared autosave pattern (no persistent saved/error-retry indicator). |
| Category deletion | `web/modules/memory/CategoryManager.tsx:230-255`; `web/lib/mutations.ts:532-538` | Explicit delete behind `ConfirmDialog`; server clears `category_id` on referencing memories and the mutation invalidates category and memory queries. | **Explicit-save justified** — destructive relationship-changing action. |
| Memory retention policy | `web/modules/settings/BrainRuntimeSection.tsx:80-141, 210-255`; `web/modules/settings/MemoryRetentionModal.tsx:35-167`; `web/app/settings/page.tsx:472-480` | Toggle and sliders update the parent runtime draft immediately. The parent autosaves the runtime block with the shared debounced controller and reports status through the active Settings hero. The modal itself only has `Done` and does not render `AutoSaveStatus`. | **Partial** — persistence is automatic and race-safe, but saving/error/retry feedback is outside the modal, in the page hero; while the modal is open that feedback is not owned by the editor and can be obscured by the modal. |
| Categorization provider/model settings | `web/modules/settings/MemorySection.tsx:31-35, 52-103, 189-214`; `web/app/settings/page.tsx:468-480, 868-870` | Provider and model drafts seed once from the server and autosave independently after the shared debounce. The aggregate section status is reported to the Settings hero; save failures toast and expose retry through the hero. | **Compliant** |
| Reindex and recategorization controls | `web/modules/memory/MemoryMaintenanceControl.tsx:16-134, 162-190`; `web/lib/mutations.ts:485-506` | Explicit job-start actions. Recategorize-all requires confirmation; running status is polled and shown with progress, completed/failed state, and toasts. | **Explicit-save justified** — these are explicit operational jobs, not field edits. |
| Bulk delete/restore/purge/empty-trash actions | `web/modules/memory/MemoryView.tsx:192-223, 506-520`; `web/lib/mutations.ts:437-484` | Explicit toolbar actions. Purge and empty-trash use confirmation dialogs; soft delete/restore fan out individual mutations; purge/empty-trash use bulk endpoints. Success and API errors are toasted, and selection is cleared after success. | **Explicit-save justified** — lifecycle and permanent-delete operations must be deliberate. |
| List filters, grouping, category panel, and sort selectors | `web/modules/memory/MemoryView.tsx:70-98, 145-159, 268-324` | View state persists immediately through `usePersistentState`/localStorage; search intentionally remains transient. These controls do not edit server data. | **N/A** |

# Missing or inconsistent auto-save

- The memory detail editor is the strongest implementation: `useAutoSaveStatus` provides an 800 ms debounce, serialized follow-up writes, flush, stale-draft protection, and retry (`web/lib/useAutoSaveStatus.ts:6-105`), while `AutoSaveStatus` renders saving/saved/error states (`web/components/ui/AutoSaveStatus.tsx:7-27`).
- The retention modal uses the same autosave lifecycle indirectly, but its only in-modal footer control is `Done` (`web/modules/settings/MemoryRetentionModal.tsx:163-166`). Status is aggregated in the Settings hero (`web/app/settings/page.tsx:472-480`), not beside the edited controls. This is inconsistent with the memory detail drawer and weakens recovery when a save fails.
- Category create/edit is intentionally an explicit atomic form, but it has only a disabled submit button and toast-based failure handling (`web/modules/memory/CategoryManager.tsx:118-135, 221-225`). There is no durable saved/error state or retry action. If explicit save remains the product decision, the shared status/retry treatment should still be considered for consistency.
- New-memory creation can partially succeed: the POST may succeed while the follow-up category PUT fails (`web/modules/memory/MemoryView.tsx:694-701`). The user sees an error toast, but the modal still reports creation and opens the new memory. The resulting uncategorized record is valid, yet the UI does not clearly distinguish “memory created, category assignment failed.”
- Bulk soft-delete and restore use `Promise.all` over independent mutations (`web/modules/memory/MemoryView.tsx:194-208`). If one request fails after others succeed, the handler only shows one error toast and leaves selection intact; there is no partial-result reconciliation or retry of only failed IDs. The explicit action is justified, but the compound operation is not fully failure-safe.
- Categorization autosave does not pass a `savable` predicate (`web/modules/settings/MemorySection.tsx:90-91`). Provider/model edits can therefore send empty or incomplete values during normal field transitions; server rejection becomes the validation path. Embedding dimensions similarly convert arbitrary text with `Number(dim)` (`:78-81`) without local finite/range validation.

# Legitimate exceptions

- **Create memory:** a multi-field creation should not materialize a server record for every intermediate draft; category assignment is also a separate audited operation.
- **Merge:** creates a new record while soft-deleting multiple sources, so explicit confirmation and submission are required.
- **Delete, purge, empty trash, and category deletion:** destructive or irreversible data changes require deliberate actions and confirmation where applicable.
- **Restore:** although reversible, it is a lifecycle command rather than an edit to a draft field.
- **Reindex and recategorize:** explicit background-job invocation is the correct interaction model; progress and terminal status are visible.
- **Category create/edit:** a category combines several fields that should commit atomically. This is defensible as an explicit-save exception, provided failure remains visible and recoverable.

# Reusable existing pattern

Use `useAutoSaveStatus` plus `AutoSaveStatus` as the canonical pattern:

- `web/lib/useAutoSaveStatus.ts:6-24` documents seed gating, bounded debounce, serialization, stale-response protection, flush, and retry.
- `web/lib/useAutoSaveStatus.ts:70-105` implements invalid-value suppression, teardown flush, and retry.
- `web/components/ui/AutoSaveStatus.tsx:7-27` provides accessible saving/saved/error-retry feedback.
- `web/modules/memory/MemoryDetail.tsx:77-92, 118-123` demonstrates a field-level draft, validity gate, explicit comparison against the server value, flush-before-close, and local status.
- `web/modules/settings/MemorySection.tsx:58-103` demonstrates seeded settings drafts, separate autosave lifecycles, aggregate status, and retry propagation to the host.
- `web/app/settings/page.tsx:139-145, 368-375, 472-480` is the existing host channel for section-level status when a section owns a page rather than a modal footer.

# Tests and gaps

Existing focused coverage:

- `web/tests/app/memory.test.tsx:220-290` covers maintenance progress, recategorize-all confirmation, completion toast, and memory/category invalidation.
- `web/tests/app/memory.test.tsx:54-73` covers category creation from the Memory page.
- `web/tests/modules/memory/CategoryManager.test.tsx:29-62` covers project scope submission and required-name validation.
- `web/tests/modules/settings/MemorySection.test.tsx:46-102` covers retryable load errors, categorization model selection, autosave, and embedding field naming.
- `web/tests/modules/settings/MemoryRetentionModal.test.tsx:38-80` covers retention controls writing into the parent draft and the pinned importance-5 behavior.
- `web/tests/modules/memory/MemoryFilterPersistence.test.tsx:50-176` covers local persistence of view filters/sort state, not server data persistence.

Gaps that would catch meaningful regressions:

- No focused `MemoryDetail` regression test verifies debounce, flush-on-Done, category plus body serialization, stale server refresh protection, or retry after a failed save.
- No end-to-end test verifies that a retention slider change reaches `PUT /config`, that the status becomes error/retryable, or that closing the modal cannot lose the last change.
- No category edit failure/retry test, and no assertion for the partial-success path where memory creation succeeds but category assignment fails.
- No bulk-action tests for duplicate clicks, partial failure in the `Promise.all` fan-out, restore, purge, or empty-trash behavior.
- `MemorySection` tests do not cover save rejection/retry or invalid intermediate provider/model/dimension values.

# Recommended migration notes

- Keep explicit submission for merge, destructive lifecycle actions, maintenance jobs, and atomic multi-field creation/category forms unless product requirements explicitly change.
- Bring the retention editor's save status into the modal (or provide an always-visible modal-level status bridge) while retaining the parent autosave owner; `Done` should remain a close action, not a save action.
- Add focused tests around the already-compliant memory detail autosave before changing it; this is the reusable reference implementation.
- Decide whether category forms should remain an explicit atomic exception. If yes, add durable pending/error-retry feedback and clarify partial category assignment after memory creation. If no, migrate them as one serialized object through `useAutoSaveStatus`, with name validity gating and flush on close.
- Replace bulk `Promise.all` handling with explicit per-ID result accounting or a server bulk endpoint before treating the action as fully durable under partial failure.
- Add local `savable` validation for categorization and embedding drafts so normal intermediate edits do not rely on server rejection as the primary validation signal.
