# Scope

Audit of the registry `todo` plugin at `/var/www/elowen-plugins/plugins/todo`, its host web surfaces, configuration/registration surfaces, drawers and modal entry points, browser persistence layer, plugin API routes, agent tools, storage lifecycle, and focused tests. The plugin provides a per-conversation task list; it has no plugin-owned `web-src` bundle.

## Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Registry manifest and marketplace record | `/var/www/elowen-plugins/plugins/todo/elowen-plugin.json:1-20`; `/var/www/elowen-plugins/registry.json:196-206` | Declares five tools and two API route groups. No `web`, `settings`, config schema, drawer, or plugin UI contribution is declared. | N/A |
| Task-manager entry points | `/var/www/elowen/web/modules/advisor/BrainChatProvider.tsx:979-995`; `/var/www/elowen/web/modules/advisor/BrainChatSurface.tsx:720-767,1337-1343` | `/tasks` opens the shared task modal. Desktop uses the toolbar; mobile uses the transient overflow popover. These controls only navigate/open the canonical surface. | N/A |
| Web task modal | `/var/www/elowen/web/modules/advisor/TasksModal.tsx:20-160` | Reads the active conversation with `useSessionTasks`. Status changes immediately issue `PATCH`; delete and bulk clear issue `DELETE` only after confirmation. Filter text is local-only. No subject, description, owner, metadata, or dependency editor exists in the web UI. | Partial |
| Status mutation UI | `/var/www/elowen/web/modules/advisor/TasksModal.tsx:40-45,66-68,119-129`; `/var/www/elowen/web/lib/mutations.ts:229-242` | Immediate, validated status mutation with optimistic cache update, rollback on error, and settled invalidation. All task mutations disable controls while pending. There is no visible “Saving” or “Saved” state and no retry action. | Partial |
| Destructive task actions | `/var/www/elowen/web/modules/advisor/TasksModal.tsx:48-64,85-93,144-158`; `/var/www/elowen/web/lib/mutations.ts:245-259` | Per-task delete and `completed`/`all` clear are explicit destructive operations behind confirmation dialogs. Successful responses sync the card and invalidate the query; failures become a toast. | Explicit-save justified |
| Live Todo card | `/var/www/elowen/web/modules/advisor/BrainChatProvider.tsx:332-345`; `/var/www/elowen/web/modules/advisor/BrainChatSurface.tsx:163-217` | Read-only projection of task state emitted by the conversation stream. It has no editable controls and therefore no independent persistence path. | N/A |
| Browser client and query boundary | `/var/www/elowen/web/lib/elowenClient.ts:27-35,173-179`; `/var/www/elowen/web/lib/queries.ts:306-311` | Same-origin `/api` calls use the httpOnly-cookie BFF. GET is keyed by session ID; mutation responses return updated task data. Query is enabled only when an active session exists. | Compliant |
| Plugin user API routes | `/var/www/elowen-plugins/plugins/todo/lib/tasks.mjs:474-553` | GET `/tasks` returns the session list; PATCH `/task` validates status and updates one task; DELETE `/task` removes one task; DELETE `/tasks` clears `completed` or `all`. Routes require a user token, integer user ID, and bounded `session` query value. | Compliant |
| Durable store and migration lifecycle | `/var/www/elowen-plugins/plugins/todo/lib/tasks.mjs:13-58,113-165,172-191,201-279,281-383` | SQLite-backed tables are migrated additively. Creates, updates, deletes, dependency changes, and clears run in transactions. Keys combine owner and conversation (`u<user>#<session>`); completed-list ageing preserves a grace period and never reuses IDs. | Compliant |
| Agent persistence tools | `/var/www/elowen-plugins/plugins/todo/lib/tasks.mjs:555-685` | `TaskCreate`, `TaskUpdate`, `TaskDelete`, and `TaskList` are the canonical agent mutation/read tools; writes are immediate and transactional. Tool schemas and runtime validation reject malformed status, missing tasks, invalid dependencies, cycles, and empty updates. | Compliant |

## Missing or inconsistent auto-save

- The editable web field is task status. It already uses the correct immediate-mutation pattern: a select change calls `PATCH` without an explicit Save button (`TasksModal.tsx:40-45,119-129`), and the server validates the allowed status set (`tasks.mjs:503-519`). Debouncing would add latency without protecting a text draft because there is no draftable text field.
- The web surface does not expose a visible saving/saved state. Pending mutations only disable controls (`TasksModal.tsx:66-68,87-92,119-135`), so users cannot distinguish a request in flight from a completed write.
- Mutation failures are surfaced through a toast (`TasksModal.tsx:44,53,62`), but the toast has no retry action. The user can repeat the select/delete action manually, but there is no explicit recovery affordance or persistent error state.
- Status updates are protected against ordinary stale query races: the mutation cancels the keyed query, snapshots the prior value, applies an optimistic update, restores the snapshot on failure, and invalidates on settlement (`mutations.ts:233-242`). Global `mutationPending` gating also prevents overlapping operations from this modal.
- Delete and clear deliberately do not auto-save because they are destructive and require confirmation. Their cache is refreshed after a successful response, while failures leave the existing list visible and show a toast (`mutations.ts:245-259`).
- There are no unsaved drafts, text debounce timers, or local persistence keys in the todo UI. The filter is a view-only local state (`TasksModal.tsx:29,33-38`) and should not be persisted.
- The plugin has no configuration/settings form or plugin-owned drawer to migrate. The only drawer-like surface is the mobile chat overflow popover, which only opens the same task modal (`BrainChatSurface.tsx:720-767`).

## Legitimate exceptions

- Per-task deletion and bulk clear are destructive operations and are correctly explicit-save/confirm actions. The UI has separate confirmations for deleting one task, clearing completed tasks, and clearing all tasks (`TasksModal.tsx:144-158`).
- The task modal exposes status only; descriptions and other private agent fields are intentionally not user-editable. The backend keeps the richer task model and dependency graph for agent operations (`tasks.mjs:315-383,622-635`).

## Reusable existing pattern

- The strongest existing pattern is the status mutation hook: cancel the relevant query, capture previous server data, optimistically update the exact row, roll back on failure, and invalidate after settlement (`/var/www/elowen/web/lib/mutations.ts:229-242`).
- The plugin API complements this with server-side validation, ownership/session scoping, and transactional writes (`/var/www/elowen-plugins/plugins/todo/lib/tasks.mjs:474-553,307-383`).
- For user-visible asynchronous state, other web surfaces should be consulted for an established `SaveStatus`/saving indicator component before adding a todo-specific status label; the current todo modal does not import or render one.

## Tests and gaps

- Web modal coverage verifies stable IDs, elapsed time, confirmation behavior, and the basic rendered surface: `/var/www/elowen/web/tests/modules/advisor/TasksModal.test.tsx:56-73`.
- Web command coverage verifies opening `/tasks`, rendering private descriptions, status update, delete confirmation, and removal from the modal: `/var/www/elowen/web/tests/modules/advisor/BrainChatWebCommands.test.tsx:266-285`.
- E2E coverage verifies the mobile overflow entry and fullscreen modal scrolling through 30 tasks: `/var/www/elowen/web/tests/e2e/specs/viewport.e2e.ts:349-384`.
- Plugin tests cover manifest parity, owner/session isolation, transactional tool behavior, API authorization and route semantics, migration, cleanup, and ID durability: `/var/www/elowen-plugins/tests/todo.test.mjs:335-417`; `/var/www/elowen-plugins/tests/todoSessionScope.test.ts:80-147`; `/var/www/elowen-plugins/tests/todoTasks.test.mjs:66-761`.
- Gaps: no focused web assertion for a visible saving/saved state, no retryable mutation error UI, no network-failure recovery test for `TasksModal`, and no browser test proving the status remains correct after a delayed response followed by a refetch. The current optimistic rollback logic is tested indirectly only through the mutation implementation pattern, not through this modal's real network path.

## Recommended migration notes

- Keep status as immediate auto-save; do not add a Save button or debounce for the current select-only editor.
- Add a compact, accessible pending/success/error state tied to the mutation lifecycle, without duplicating server state or introducing local drafts.
- Give mutation failures a retry action that replays the exact task ID and desired status, and preserve the current rollback/invalidation behavior.
- Retain confirmation dialogs for delete and clear; these are legitimate destructive-operation exceptions rather than auto-save defects.
- If future fields become editable, reuse the existing query-cancel/optimistic-update/rollback/invalidate pattern and add stale-draft protection before exposing them in the modal.
