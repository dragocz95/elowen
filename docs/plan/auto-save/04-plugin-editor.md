# Plugin editor auto-save audit

## Scope

Audited the registry plugin at `/var/www/elowen-plugins/plugins/editor`, including its standalone page, embedded/fullscreen editor surface, file-operation dialogs, menus/settings, upload/download and read-only views, manifest configuration, direct host callers, shared persistence hooks, and the plugin's project-file API.

The plugin has no declared plugin configuration schema and owns no drawer component. The Projects surface navigates to `/p/editor` with query parameters (`/var/www/elowen/web/modules/projects/ProjectsView.tsx:82-90`); the editor itself is rendered inline or in the shared `WorkspaceTakeover` (`web-src/ProjectEditor.tsx:552-575`).

## Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Standalone editor page and project selector | `web-src/EditorPage.tsx:28-40,49-74`; host `web/lib/useProjectFilter.ts:19-31`, `web/lib/usePersistentState.ts:4-34` | Project selection is validated and written immediately to `localStorage` through the host's persistent-state hook. The deep-link project/commit/working selection is URL state, not edited data. | N/A |
| Plugin manifest/config surface | `elowen-plugin.json:7-43,45-118`; `web-src/index.tsx:4-7` | Manifest declares capabilities, API routes, navigation and strings only; there is no `config` schema, settings form, or plugin-config mutation in this plugin. | N/A |
| Inline editor shell and fullscreen takeover | `web-src/editor/ProjectEditor.tsx:46-115,163-181,552-575` | Editor height and Monaco preferences are restored from and immediately written to `localStorage` (`EDITOR_H_KEY`, `PREFS_KEY`). Draft file contents remain only in React state (`drafts`, `dirtyPaths`) and disappear when the editor component unmounts. | Partial |
| Text-file editing | `web-src/editor/ProjectEditor.tsx:129-159,183-205,367-381,492-497`; `web-src/editor/EditorPane.tsx:11-47`; `i18n/cs.json:31-32,78` | `onChange` updates an in-memory draft. Persistence occurs only through an explicit Save button or Cmd/Ctrl+S, calling `useWriteProjectFile().mutateAsync`. Success/error are transient toasts; the status bar only marks unsaved state. There is no debounce, auto-save status, retry control, draft persistence, or close guard. | Missing |
| Open tabs and navigation between files | `web-src/editor/Tabs.tsx:5-31`; `web-src/editor/ProjectEditor.tsx:207-230,480` | Switching tabs preserves drafts in the parent; closing a tab removes only the tab/selection, not the draft. Leaving the page/takeover unmounts the parent and drops all unsaved drafts. | Partial |
| New file/folder, rename and duplicate dialogs | `web-src/editor/dialogs.tsx:10-39`; `web-src/editor/ProjectEditor.tsx:271-287` | A validated text input submits an immediate explicit filesystem mutation on Enter or confirmation. The mutation invalidates the project tree and the UI shows a success/error toast. | Explicit-save justified |
| Delete confirmation dialog | `web-src/editor/dialogs.tsx:42-57`; `web-src/editor/ProjectEditor.tsx:288-293,544-548` | Destructive deletion requires an explicit confirmation and then immediately calls the delete API. Errors are surfaced by toast. | Explicit-save justified |
| File/View/Settings menus | `web-src/editor/ProjectEditor.tsx:320-350`; `web-src/editor/editorOptions.ts:15-41` | View and editor preferences (word wrap, minimap, font size, tab size) are validated and written synchronously to local storage on each menu action. They do not need an explicit Save action. | Compliant |
| Upload picker and drag/drop | `web-src/editor/ProjectEditor.tsx:235-260,328,426-458,533-541`; `web-src/editor/upload.ts:11-41` | User-initiated uploads use explicit picker/drop actions and sequential chunked `fetch` PUTs. Progress is represented by an `Uploading…` label; individual failures are toasted and the remaining files continue. | Explicit-save justified |
| Preview, binary download, working diff and commit diff | `web-src/editor/ProjectEditor.tsx:478-511`; `web-src/editor/BinaryPreview.tsx:17-49`; `web-src/editor/MediaPreview.tsx:1-4` | Read-only views and downloads perform reads only; no user-authored values are persisted. | N/A |
| Host write mutation and cache synchronization | host `web/lib/mutations.ts:346-375`; host `web/lib/elowenClient.ts:368-370` | Writes are serialized per project/path, update the file cache synchronously, and invalidate file, Git and changed-path queries. The editor retires a draft only when the returned write matches the latest draft (`ProjectEditor.tsx:191-200`). | Partial |
| Registry project-file API | `src/api.ts:45-63,121-138`; `src/files.ts:53-64,128-199` | Authenticated project-scoped routes support read, direct write, create, rename, copy, delete, chunk upload, raw reads and Git reads. Input/path checks and project authorization exist, but normal text writes use direct `writeFileSync` with no revision/ETag or atomic temp-file replacement. Uploads are the exception: they use a temporary `.elowen-upload` and final rename (`src/files.ts:135-167`). | Partial |

## Missing or inconsistent auto-save

- The primary editable surface is explicitly saved only: the Save button is rendered at `web-src/editor/ProjectEditor.tsx:367-380`, and Monaco binds Cmd/Ctrl+S at `web-src/editor/EditorPane.tsx:27-29`. No `useAutoSaveStatus`, debounce, or equivalent scheduler is used anywhere in the plugin.
- The editor has a dirty indicator (`dirtyPaths` and `statusUnsaved`) but no distinct saving/saved/error state or retry action. The only feedback is a success/error toast from `ProjectEditor.tsx:191-204`; the Save button is merely disabled while the mutation is pending (`:379`).
- Draft contents are memory-only (`ProjectEditor.tsx:71-80,141-159`). Closing the desktop editor, leaving the mobile takeover, pressing Escape, or navigating away does not flush or confirm pending edits. `leaveFullscreen` only changes UI/navigation state (`:170-174`), and the mobile `onClose` navigates back/dashboard (`EditorPage.tsx:42-47`).
- A file can be closed or deleted while dirty. `Tabs.tsx:20-26` exposes close without a dirty confirmation, and `confirmDelete` deletes/removes the path (`ProjectEditor.tsx:288-293`) without warning about an unsaved draft.
- The existing same-file write queue protects overlapping writes from this browser instance (`web/lib/mutations.ts:346-358`) and the draft-retirement check protects newer keystrokes (`ProjectEditor.tsx:193-200`), but the server API has no optimistic-concurrency token. A second browser/process can overwrite a newer edit without conflict detection.
- Server refreshes do not replace a non-empty local draft, which is a useful stale-draft safeguard because `value` prefers `draft` over `serverContent` (`ProjectEditor.tsx:141-144`). However, the draft has no durable recovery if the component is remounted or the browser reloads.
- The host already publishes a race-safe auto-save controller (`web/lib/useAutoSaveStatus.ts:4-30`) and exposes it to plugin bundles (`web/lib/pluginUi.tsx:341-354`), but the editor's runtime contract does not include it (`web-src/runtime.tsx:29-54`). This is an inconsistency with the shared platform pattern.

## Legitimate exceptions

- New file, new folder, rename, duplicate and delete are discrete filesystem operations, not continuous field edits. Explicit confirmation is appropriate, especially for delete (`dialogs.tsx:42-57`).
- Uploads are user-directed transfers and already use explicit picker/drop gestures, bounded chunks and an atomic final rename. Auto-starting an upload from a partially selected file list would change the operation's semantics.
- Read-only previews, binary downloads, Git history and diff views are not persistence surfaces.
- Local editor preferences and height are suitable for immediate device-local persistence; they should not create server writes or require a Save button.

## Reusable existing pattern

The host's `useAutoSaveStatus` is the canonical reusable mechanism: it skips the seed value, debounces valid changes, serializes a follow-up write when edits arrive during an in-flight request, exposes `status`, `retry` and `flush`, and flushes pending work during teardown (`web/lib/useAutoSaveStatus.ts:7-17,45-105`).

The editor can also reuse the existing write guarantees rather than adding another transport: `useWriteProjectFile` serializes writes per project/path and updates/invalidate the relevant caches (`web/lib/mutations.ts:352-375`). Its focused tests cover same-file ordering, parallel writes, queue recovery after failure, cache invalidation and synchronous cache replacement (`web/tests/lib/writeProjectFile.test.tsx:43-98`; `web/tests/lib/mutations.test.tsx:89-114`).

## Tests and gaps

- Existing host tests provide good persistence-API coverage for ordering and cache consistency: `web/tests/lib/writeProjectFile.test.tsx:43-98` and `web/tests/lib/mutations.test.tsx:89-114`.
- The responsive takeover E2E test verifies the editor's fullscreen lifecycle, Escape handling, focus trap, viewport sizing and accessible exit (`web/tests/e2e/specs/plugin.viewport.e2e.ts:187-246`), but it does not open a dirty file and verify save/flush behavior on exit.
- The plugin checkout contains no focused component or end-to-end test for `ProjectEditor` save behavior, dirty-tab closing, navigation with drafts, error retry, or server-refresh conflict handling.
- Missing regression coverage should specifically exercise: edits followed by debounce save; edits during an in-flight write; failed save followed by retry; closing/back navigation with a pending edit; dirty tab/file deletion; and a concurrent server revision conflict if the API gains versioning.

## Recommended migration notes

- Expose the already-published host `useAutoSaveStatus` in `web-src/runtime.tsx`, then use it for editable text drafts with a bounded debounce and the existing `mutateAsync` write path. Keep the current latest-content check and host per-file serialization as the safety layers.
- Add a compact editor-owned status with saving, saved, error and retry states. Keep the existing unsaved indicator for dirty content; a success toast alone is too transient to prove persistence.
- Flush pending debounce work before editor close, mobile back, fullscreen exit and project/file destruction, and define a clear policy for an in-flight write. At minimum, warn before discarding a dirty draft; do not silently unmount it.
- Preserve explicit confirmation for destructive file operations and explicit user initiation for uploads. Consider including a dirty-draft warning when deleting a dirty file.
- Add a server-side revision/mtime or conditional-write contract if multi-client editing is supported. Direct `writeFileSync` (`src/files.ts:60-64`) is not atomic and cannot detect a stale client; changing that contract should be treated as a separate API/data-integrity decision.
