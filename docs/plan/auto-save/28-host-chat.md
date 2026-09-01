# Scope

Audit of editable Chat UI surfaces in the host web application under `web/modules/advisor`, `web/modules/chat`, and the core conversation register used by Chat. The audit covers conversation metadata, model/reasoning/work-mode controls, drawers/modals, task/skill actions, and browser-local chat preferences. Read-only transcript, telemetry, statistics, help, process, workflow, and image overlays are inventoried where they host controls but are not treated as editable settings.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Conversation history rail/drawer/dropdown: search, switch, new chat, fork, export | `web/modules/advisor/ChatHistoryRail.tsx:85-101,118-173,229-376`; `web/modules/chat/ChatView.tsx:70-100` | Search/filter is transient and debounced to `brainSearch`; switching/new/fork/export are immediate actions. No setting is being edited. | N/A |
| Inline conversation rename in history | `web/modules/advisor/ChatHistoryRail.tsx:140-160,212-223,311-326` | Draft is local; Enter or blur immediately PATCHes `brainRenameSession`, then invalidates `['brain-sessions']`. Escape cancels. Failure is only a toast; there is no saving/saved/error+retry status. | Partial |
| Open-chat rename modal (`/rename`) | `web/modules/advisor/BrainChatSurface.tsx:772-795,1712-1718`; `web/modules/advisor/BrainChatProvider.tsx:962-971` | Local draft is committed only by Enter or an explicit `Save` button. Mutation closes the modal before the request and reports failure only through a toast. | Missing |
| Model picker (header/dock popover and `/model` modal) | `web/modules/advisor/ModelPicker.tsx:14-63`; `web/modules/advisor/ModelModal.tsx:10-35`; `web/modules/advisor/ModelOptionList.tsx:62-194`; `web/modules/advisor/BrainChatProvider.tsx:885-910` | Catalog is lazy-loaded once. Selection immediately calls `POST /brain/model`; the active label is updated from the response and success/failure is shown as a toast. The picker has loading/error/retry for catalog fetch, but not for the model mutation; concurrent selections have no request-order guard. | Partial |
| Project / working-directory picker | `web/modules/advisor/ProjectPicker.tsx:40-149` | Selection immediately calls `POST /brain/cwd`; the control is disabled while moving, and the daemon-confirmed path is held until status catches up. Failure is a daemon-error toast, with no persistent saving/saved state or retry affordance. | Partial |
| Reasoning effort selector | `web/modules/advisor/ReasoningModal.tsx:16-77`; `web/lib/elowenClient.ts:231-234` | Slider change optimistically updates the local applied value, immediately calls `POST /brain/think`, rolls back on failure, and invalidates account settings on success. No saving/saved/error+retry status; repeated changes can race because there is no pending/request fence. | Partial |
| Thought-row visibility toggle | `web/modules/advisor/ReasoningModal.tsx:24-74`; `web/modules/advisor/BrainChatProvider.tsx:389-392,1146-1149`; `web/lib/usePersistentState.ts:4-34` | Immediate validated `localStorage` persistence under `elowen.chat.thoughts`; the transcript changes immediately and the value rehydrates on mount. This is a device-local display preference, not an account mutation. | Compliant |
| Work-mode control (`/plan`, `/build`, `/workflow`) and phone overflow display | `web/modules/advisor/BrainChatProvider.tsx:371-379,911-915,995-998`; `web/modules/advisor/BrainChatSurface.tsx:703-769,1297-1344`; `web/tests/modules/advisor/BrainChatWebCommands.test.tsx:144-177` | Deliberately in-memory, tab-scoped state. The selected mode is stamped only onto the next send; reload resets to `build`. No server setting or draft is being edited. | N/A |
| In-chat statusline collapse preference | `web/modules/advisor/BrainChatSurface.tsx:837-841,1484-1504`; `web/lib/usePersistentState.ts:18-34` | Immediate validated `localStorage` persistence under `elowen.chat.statusline`; it is a device-local presentation choice. | Compliant |
| Conversation register modal and admin “all/mine” view preference | `web/components/brain/BrainSessionsPanel.tsx:61-118,199-237`; `web/modules/chat/ChatView.tsx:41-43,93-100` | Register search, sorting, pagination, and filters are transient. Admin view is immediately persisted and validated in `elowen.sessions.brainView`; conversation actions are immediate server operations. | Compliant for the local view preference; N/A for transient register controls |
| Conversation task status selector | `web/modules/advisor/TasksModal.tsx:20-45,66-129`; `web/lib/mutations.ts:229-242` | Select change immediately mutates the task with optimistic cache update, rollback on error, and query invalidation. The whole task surface is disabled while any mutation is pending; errors are toasts, not inline save/retry status. | Partial |
| Task delete / clear-completed / clear-all | `web/modules/advisor/TasksModal.tsx:48-64,85-95,144-158` | Explicit confirmation precedes destructive immediate mutations. This is an appropriate explicit action; it is not an auto-save candidate. | Explicit-save justified |
| Skill load action and user-skill deletion | `web/modules/advisor/SkillsModal.tsx:17-21,38-49,51-116`; `web/lib/mutations.ts:261-266` | Loading sends `/skill:name` as a deliberate conversation action. Deletion requires confirmation and then immediately mutates; failure is a toast and the modal remains available. | Explicit-save justified for deletion; N/A for load |
| Parked AskUserQuestion / approval form | `web/modules/advisor/AskQuestionCard.tsx:26-75,106-187`; `web/modules/advisor/BrainChatProvider.tsx:859-870` | Local selections are submitted atomically through one explicit answer action. Pending disables the form; failure preserves selections and re-enables retry. This is a multi-question/approval decision, not a setting edit. | Explicit-save justified |
| Plan implementation decision | `web/modules/advisor/PlanDecisionModal.tsx:7-37`; `web/modules/advisor/BrainChatProvider.tsx:927-960` | Explicit Implement/Cancel decision; submission is guarded against double-clicks and the decision remains available when implementation fails. This is a consequential, multi-step action rather than editable metadata. | Explicit-save justified |
| Read-only overlays: agents, stats, help, process output, workflow, image lightbox and telemetry drawer | `web/modules/advisor/AgentsTable.tsx:123-247`; `StatsModal.tsx:18-49`; `HelpModal.tsx:16-61`; `ProcessPanel.tsx:12-39`; `WorkflowModal.tsx:40-266`; `BrainChatSurface.tsx:481-519`; `TelemetryPanel.tsx:176-228,413-429` | These surfaces inspect live/server state. Filters are local-only; process kill is a confirmed destructive action. No editable preference is present. | N/A, except process kill is Explicit-save justified |

# Missing or inconsistent auto-save

- Conversation title editing has two incompatible experiences for the same metadata: the history rail commits on blur/Enter (`ChatHistoryRail.tsx:140-160`), while the open-chat dialog requires an explicit Save button (`BrainChatSurface.tsx:772-795`). Neither path exposes a saving/saved/error+retry state. The shared mutation also closes the modal before completion (`BrainChatProvider.tsx:962-971`), so a failed save gives no retained retry affordance.
- Model switching is an immediate mutation, which is appropriate for a single choice, but it only exposes success/error toasts (`BrainChatProvider.tsx:902-910`). There is no mutation-pending state, retry control, or stale-response fence if the user selects multiple models quickly; an older response can temporarily overwrite the current label.
- Working-directory switching has better lifecycle protection (`moving` disables the picker and the response seeds the confirmed path), but still lacks a visible saved/error+retry state. A user can retry only by reopening the picker after a failure (`ProjectPicker.tsx:84-98`).
- Reasoning effort uses optimistic state and rollback, but lacks visible saving/error status and serializes neither rapid slider changes nor response ordering (`ReasoningModal.tsx:32-46`). The account-default invalidation is correct, but does not provide a retry path.
- Task status has a strong shared mutation implementation with optimistic update and rollback (`web/lib/mutations.ts:233-242`), yet the modal exposes only disabled controls plus an error toast (`TasksModal.tsx:40-45,66-68`). It is operationally safe but not a complete canonical save-status experience.
- Local preferences use the shared validated persistence helper, but `usePersistentState` silently ignores storage failures (`web/lib/usePersistentState.ts:18-31`). For device-local display toggles this is a minor durability gap rather than a network autosave defect; there is no way to show or retry quota/private-mode failures.
- No chat surface uses the shared `useAutoSaveStatus`/`AutoSaveStatus` controller. The host therefore has no common visible saving/saved/error+retry treatment for its server-backed immediate mutations, unlike the established settings/account surfaces.

# Legitimate exceptions

- Work mode is intentionally tab-memory state: persisting it would stamp a reloaded tab with a mode the user did not choose (`BrainChatProvider.tsx:371-379`). Keep it out of account autosave.
- Composer text and staged attachments are transient work-in-progress. The provider deliberately preserves them across surface/route toggles, but must not submit or persist them as conversation content before the user sends (`BrainChatProvider.tsx:717-750`; `BrainChatSurface.tsx:1582-1708`).
- Task deletion/clearing, skill deletion, process kill, plan implementation, and AskUserQuestion/approval answers are explicit consequential actions. Confirmation or one atomic submit is preferable to background persistence.
- Export, fork, new conversation, skill load, and slash actions are commands, not editable settings.
- Search, sorting, pagination, catalog filters, and modal filters are transient view state; persisting them would add noise without protecting user data.

# Reusable existing pattern

The host should reuse the existing shared autosave contract rather than inventing per-picker status logic:

- `web/lib/useAutoSaveStatus.ts:7-24,26-105` provides debouncing, seed gating, validity gating, serialized latest-state writes, flush-on-close/unmount, stale-write protection, and retry.
- `web/components/ui/AutoSaveStatus.tsx:7-27` provides accessible `saving`, `saved`, and `error`/`retry` feedback.
- Existing consumers demonstrate the intended composition, for example account personality autosave at `web/modules/account/PersonalitySection.tsx:25-53,112` and settings modal autosave at `web/modules/settings/ModelNoteModal.tsx:12-42`.
- For immediate single-choice controls, retain the existing optimistic/rollback or daemon-confirmed mutation semantics, but wrap them in one shared mutation-status contract (pending/success/error/retry) and guard response ordering. Do not debounce actions whose meaning is “switch now”.

# Tests and gaps

Inspected focused coverage includes:

- Rename wiring and cancellation: `web/tests/modules/advisor/ChatHistoryRail.test.tsx:173-195`; open-chat `/rename`: `web/tests/modules/advisor/BrainChatWebCommands.test.tsx:179-191`.
- Model catalog loading, retry, grouping, selection, and keyboard behavior: `web/tests/modules/ModelPicker.test.tsx:48-141`; slash model switching: `BrainChatWebCommands.test.tsx:375-394`.
- Reasoning effort, thought visibility, persistence, and empty-level behavior: `BrainChatThoughts.test.tsx:64-111`; `BrainChatWebCommands.test.tsx:193-243`.
- Work-mode stamping and failed plan retry: `BrainChatWebCommands.test.tsx:144-177,302-337`.
- Task status update and destructive delete: `BrainChatWebCommands.test.tsx:266-285`.
- Register view/search/sort and modal integration: `web/tests/components/brain/BrainSessionsPanel.test.tsx:98-132,174-225`; `web/tests/modules/chat/ChatView.test.tsx:106-121`.

Gaps relevant to migration:

- No focused test asserts a visible saving/saved/error+retry state for rename, model, project, reasoning, or task status mutations.
- No test covers retrying a failed rename/model/project/reasoning mutation from the same surface.
- No test covers rapid consecutive model or reasoning changes and stale response ordering.
- No test verifies that an in-flight title edit survives a modal close or is flushed without being dropped; the current rename modal has no flush behavior.
- No test covers localStorage quota/private-mode failure for `usePersistentState`; failures are intentionally swallowed.
- The audit did not run the test suite; this report is source/test inspection only.

# Recommended migration notes

- Define one canonical conversation-title editor behavior for both the rail and open-chat modal. Prefer debounced autosave with flush on blur/close, visible `AutoSaveStatus`, retained draft on failure, and retry; keep Escape as cancel only when it is explicitly intended to discard.
- Add a small shared immediate-mutation status adapter for model, project, reasoning, and task status controls. It should disable only the affected control while pending, expose saved/error+retry feedback, and reject stale responses rather than relying on a later status poll to repair labels.
- Preserve server-confirmed/optimistic semantics already present: project paths must continue to come from the daemon, reasoning must roll back rejected levels, and task status must keep its optimistic rollback.
- Keep work mode, composer drafts, filters, sorting, and other transient view state out of server autosave. Keep destructive and consequential decisions explicit.
- Add focused regression tests for each mutation's pending/success/error/retry path and for overlapping requests before changing production behavior.
