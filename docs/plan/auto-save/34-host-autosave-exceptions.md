# Scope

This audit covers host-web forms, drawers, toggles, selectors, and action dialogs in `/var/www/elowen/web`, plus registry-plugin web surfaces under `/var/www/elowen/plugins`, where automatic persistence would be unsafe or semantically wrong for secrets, destructive operations, consent, uploads, authentication/device flows, or externally verified credentials. Normal preference fields that already use the shared auto-save controller are treated as the baseline, not as exceptions.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Login and Microsoft SSO | `web/components/auth/LoginForm.tsx:24-75,98-125`; `web/lib/mutations.ts:36-37`; `web/app/api/auth/login/route.ts` | Username/password remain local until an explicit form submit. SSO is an explicit navigation to the provider; the session is an httpOnly cookie, not client-persisted state. | Explicit-save justified |
| Add user | `web/modules/users/UsersView.tsx:41-87,270-282` | Username and initial password stay in a modal draft and are sent only by the explicit `Create` submit. Error handling keeps the entered draft visible. | Explicit-save justified |
| Change account password | `web/modules/account/AccountView.tsx:281-294,510-584`; `web/lib/mutations.ts:79-80` | Current password, new password, and confirmation are local password inputs; validation and the explicit footer submit invoke one password mutation. Inputs are cleared only after success. | Explicit-save justified |
| Avatar upload | `web/modules/account/AccountView.tsx:276-279,484-499`; `web/lib/mutations.ts:75-77`; `web/lib/elowenClient.ts:116` | File selection intentionally starts an immediate multipart upload. The input is reset to allow the same file again; pending state and success/error toasts provide feedback. | Explicit-save justified |
| Browser push permission / device subscription | `web/modules/account/AccountView.tsx:136-140,233-260,598-612`; `web/lib/pushClient.ts:37-60` | A device-specific toggle explicitly requests browser permission or subscribes/unsubscribes the current device. It is not a normal persisted preference and must not be triggered by a debounce. | Explicit-save justified |
| API-key brain provider editor | `web/modules/settings/BrainProvidersSection.tsx:196-220,243-364,450-485`; `web/lib/mutations.ts:298-304` | Endpoint, models, and API key are held in a modal draft. The key is omitted when blank (preserving an existing key), and the whole provider record is sent only by `Save`; the modal is disabled while saving. | Explicit-save justified |
| OAuth provider connect/device flow | `web/modules/settings/BrainProvidersSection.tsx:82-147,489-492,673-686` | `Connect` starts a server-side flow, the dialog shows an auth URL/device code, optionally submits a pasted code, then polls until success/error. Cancellation is distinct from failure and late poll results are generation-guarded. | Explicit-save justified |
| OAuth disconnect | `web/modules/settings/BrainProvidersSection.tsx:688-699`; `web/lib/mutations.ts:306-308` | Disconnect is staged behind `ConfirmDialog`; the mutation starts only after confirmation. | Explicit-save justified |
| Externally verified hosted tool search | `web/modules/settings/BrainProvidersSection.tsx:394-409,494-509,613-625`; `web/tests/modules/settings/BrainSection.test.tsx:148-180` | Verification is an explicit provider-scoped action, not a side effect of editing/saving. The exact provider/model deployment is probed, status is refreshed, and stale status responses are rejected. | Explicit-save justified |
| Generic plugin secret fields | `web/modules/settings/PluginConfigEditor.tsx:869-900`; `web/lib/usePluginConfigDraft.ts:72-80`; `web/modules/settings/PluginDetail.tsx:58-64`; `plugins/web/elowen-plugin.json:37-46` | Stored secrets are masked and require an explicit `Replace` action to reveal an input, but the replacement value then enters the generic 900 ms auto-save draft and is persisted without a separate commit. | Missing |
| Plugin role-policy removal and risk-labelled config | `web/modules/settings/PluginConfigEditor.tsx:360-423,743-751`; `web/tests/modules/settings/PluginConfigEditor.test.tsx:94-122` | Removing a role policy uses an explicit confirmation and immediate commit; risk enum fields otherwise flow through the generic auto-save draft. The deletion path is safe, but the risk-field policy is not differentiated by risk. | Partial |
| Plugin capability consent (enable/install) | `web/modules/settings/usePluginConsent.tsx:22-109`; `web/modules/settings/PluginActions.tsx:9-30`; `web/modules/settings/PluginsSection.tsx:405-413` | The daemon rejects unacknowledged powers with a structured `409`; the hook turns that response into one confirmation naming every grant, then replays the same operation with acknowledgement. | Compliant |
| Plugin uninstall and plugin-data clear | `web/modules/settings/PluginsSection.tsx:405-412`; `web/modules/settings/PluginDataPanel.tsx:24-55`; `web/lib/mutations.ts:179-182,290-296` | File removal, soft-removal, and data-directory clearing are explicit destructive actions behind confirmation dialogs, with pending/error handling owned by the action. | Compliant |
| Memory detail delete / restore | `web/modules/memory/MemoryDetail.tsx:77-103,124-129,201-207` | Content edits auto-save, but delete is separated from editing and requires confirmation; restore is an explicit action. | Compliant |
| Memory bulk delete, purge, and empty trash | `web/modules/memory/MemoryView.tsx:192-224,506-519,533-547` | Permanent purge and empty-trash are confirmed. Bulk soft-delete is sent immediately from the floating toolbar without confirmation, despite being a destructive state change. | Missing |
| Memory category deletion | `web/modules/memory/CategoryManager.tsx:230-255` | Category deletion is explicit and confirmed; the server clears references from memories. | Compliant |
| Memory maintenance “all” recategorization | `web/modules/memory/MemoryMaintenanceControl.tsx:104-134` | The broad operation is separated from the ordinary uncategorized operation and requires a confirmation dialog before starting. | Compliant |
| User deletion and administrator-role changes | `web/modules/users/UsersView.tsx:48-102,289-309`; `web/lib/mutations.ts:55-68` | Delete and role changes are staged in separate confirmation state; no mutation occurs when the menu/dialog opens. Pending role changes cannot be double-submitted. | Compliant |
| Project removal | `web/modules/projects/ProjectsView.tsx:176-192,458-484`; `web/lib/mutations.ts:318-320` | The edit modal can stage a remove request, but the actual removal is confirmed and guarded against concurrent submissions. | Compliant |
| Session deletion, including delete-all | `web/modules/advisor/ChatHistoryRail.tsx:175-223,356-372`; `web/components/brain/BrainSessionsPanel.tsx:228-235,356-372` | Individual and bulk history deletion use confirmation. Async delete keeps the dialog/list owned and retryable when the request fails. | Compliant |
| Log-file deletion | `web/modules/settings/LogsModal.tsx:251-284`; `web/lib/mutations.ts:107-127` | Individual and delete-all operations are separate confirmed actions; cached file content is removed after success. | Compliant |
| Session task deletion and clear-all | `web/modules/advisor/TasksModal.tsx:57-68,85-93,144-158` | Status changes are direct because they are workflow state edits; deletion and both clear scopes are explicit confirmation flows. | Compliant |
| Skill deletion | `web/modules/advisor/SkillsModal.tsx:89-115` | Delete is permission-gated and confirmed; loading a skill is a separate explicit action. | Compliant |
| Permission-rule add/delete | `web/modules/account/PermissionRulesCard.tsx:149-183` | Adding is an explicit form submit; deleting a rule is staged behind confirmation before replacing the stored rule list. | Compliant |
| MCP server editor | `plugins/mcp/web-src/McpServersPage.tsx:13-55,169-305,362-395`; `plugins/mcp/web-src/McpServersPage.tsx:450-469,593-640`; `plugins/mcp/elowen-plugin.json:57-93` | Command, URL, arguments, environment values, ownership, and enabled state remain in a drawer draft and are sent only by `Save`. Scope moves are a separate ordered operation; removal is confirmed. | Explicit-save justified |
| Account-HOME reset | `plugins/sandbox/web-src/EnvironmentSettings.tsx:22-43,124-152`; `plugins/sandbox/elowen-plugin.json:162-174` | Reset first obtains a server-side loss preview, then requires an exact confirmation phrase and preview hash before the destructive mutation. Active processes disable the action. | Compliant |
| Chat file attachments | `web/modules/advisor/brainChatAttachments.ts:29-54`; `web/modules/advisor/BrainChatSurface.tsx:1622-1629`; `web/tests/modules/advisor/BrainChatAttach.test.tsx:87-138` | Selecting a file explicitly starts an upload into the project; the composer stores only the returned path and sends that path in the message. Failed uploads stage nothing. | Explicit-save justified |
| Markdown asset editor and removal | `web/modules/settings/MarkdownAssetEditor.tsx:388-406` | Document edits use an explicit `Save`; removal is a separate confirmed action. This avoids treating a multi-line document or file-like asset as a field-level auto-save. | Explicit-save justified |

# Missing or inconsistent auto-save

- **Generic plugin secrets are the clearest exception breach.** `PluginConfigEditor` correctly hides an existing secret and exposes it only after `Replace` (`PluginConfigEditor.tsx:869-900`), but `usePluginConfigDraft` auto-saves every changed value after 900 ms (`usePluginConfigDraft.ts:72-80`). A pasted or partially typed replacement can therefore be persisted before the user has intentionally committed it. The `web` registry manifest demonstrates real secret fields (`plugins/web/elowen-plugin.json:37-46`).
- **Bulk memory soft-delete bypasses the established destructive-action pattern.** The toolbar invokes `bulkDelete` directly (`MemoryView.tsx:506-517`), and `bulkDelete` fans out mutations immediately (`MemoryView.tsx:192-200`). Permanent deletion is confirmed in the same component, so the missing confirmation is inconsistent rather than an intentional product distinction.
- **OAuth device-code submission has weaker feedback than the surrounding flow.** The code form calls `brainOauthInput` and immediately clears the input without awaiting success/failure (`BrainProvidersSection.tsx:136-141`). Polling protects the final flow state, but the input submission itself has no pending, error, or retry state and can be repeated while a prior request is unresolved.
- **Plugin risk metadata is presentation-only.** Risk-labelled enum controls are still ordinary generic draft fields (`PluginConfigEditor.tsx:743-751`); only role-policy removal gets confirmation. A manifest can describe a value as including delete/anonymize while the host still persists it automatically.
- **MCP environment values are explicit-save but not secret-aware.** The drawer treats `env` as a plain textarea (`McpServersPage.tsx:248-253`) and the manifest explicitly describes personal credentials (`mcp/elowen-plugin.json:57-62`). This is safer than auto-save, but the host does not provide masking, replacement semantics, or a secret-specific contract for those values.
- **Uploads correctly avoid auto-save semantics, but feedback is heterogeneous.** Chat attachments return a structured failure and stage nothing (`brainChatAttachments.ts:35-54`), while avatar upload uses mutation pending plus toasts (`AccountView.tsx:276-279`). Both are acceptable immediate actions, but neither uses the shared `AutoSaveStatus` because they are transfers, not drafts.

# Legitimate exceptions

The following operations should remain explicit rather than being converted to field-level auto-save:

- **Secrets and authentication:** passwords, API keys, environment credentials, login credentials, and device codes have security and intent boundaries. Persist only after an explicit submit/replace action; never rehydrate stored secret material into the browser.
- **Destructive or difficult-to-reverse operations:** deletion, purge, uninstall, reset, role demotion, permission-policy removal, and broad bulk actions need an explicit confirmation. A preview/hash or exact phrase is appropriate when the blast radius is large.
- **Consent and capability grants:** enabling/installing a plugin or enabling exact request capture changes what data or powers are handed over. Ask only after the server identifies the precise grant set, then replay the same mutation with the acknowledgement.
- **Uploads and downloads:** file selection is an explicit transfer boundary. Start the transfer immediately or require an explicit upload action, but do not debounce raw file objects as if they were ordinary settings. Preserve an actionable failure and do not stage a reference until the transfer succeeds.
- **Authentication/device/OAuth flows:** explicit start, explicit code submission, cancellation, polling, and terminal success/error are a flow state machine, not a form draft.
- **Externally verified credentials/configuration:** probing an endpoint or deployment must be an explicit, provider-scoped verification action. Saving a URL/key must not silently claim that the credential works.
- **Multi-step or externally activated forms:** provider records, MCP server definitions, and file-like documents combine values whose validity and side effects are evaluated together. An explicit commit preserves atomic intent and prevents partially valid snapshots from activating.

# Reusable existing pattern

The host already has a strong common pattern for justified exceptions:

1. Keep an isolated local draft or pending action; opening a drawer/dialog must not mutate server state.
2. Use a clearly labelled explicit action (`Save`, `Create`, `Connect`, `Upload`, `Delete`, or `Confirm`) tied to the whole operation.
3. Validate before sending and keep the surface open on failure so the user can correct or retry.
4. Disable duplicate submissions while pending. `ConfirmDialog` centrally blocks dismissal during async confirmation, starts focus on the safe cancel action, and restores focus afterward (`web/components/ui/ConfirmDialog.tsx:24-39,72-114`).
5. Show a terminal outcome. Existing surfaces use toasts, inline errors, pending labels, or `AutoSaveStatus`; the exception should never silently disappear.
6. Protect races and stale state: serialize compound writes, generation-guard polling/probes, refresh after destructive mutations, and do not let a server refresh overwrite an active draft.
7. For secrets, show only presence (`secretSet`), offer an explicit replacement affordance, send only the replacement value, and clear sensitive local state after a successful credential change.
8. For consent, let the backend identify the exact requested powers, display all of them, and replay the same operation with an acknowledgement rather than inventing a second client-side permission model.

# Tests and gaps

Existing focused coverage confirms most of the pattern:

- Authentication cookie and CSRF behavior: `web/tests/app/api/auth.test.ts:13-106` and SSO flow coverage in `web/tests/app/api/authSso.test.ts:28-86`.
- User deletion/role confirmation and draft preservation: `web/tests/modules/users/UsersView.test.tsx:93-185`.
- Provider verification and stale-response protection: `web/tests/modules/settings/BrainSection.test.tsx:148-180`.
- Capture consent failure, pending lock, and cancellation behavior: `web/tests/modules/settings/ConversationDiagnosticsModal.test.tsx:164-239`.
- Plugin role-policy confirmation and persistence failure handling: `web/tests/modules/settings/PluginConfigEditor.test.tsx:94-122`.
- Stored-secret masking and explicit replacement affordance: `web/tests/modules/settings/PluginDetail.test.tsx:430-449`.
- Attachment staging, path-only message references, arbitrary file types, and failed-transfer behavior: `web/tests/modules/advisor/BrainChatAttach.test.tsx:87-138`.
- Avatar/platform-link behavior and explicit disconnect semantics: `web/tests/modules/account/AccountView.test.tsx:174-241`.
- Plugin consent replay is covered in `web/tests/modules/settings/PluginsSection.test.tsx:172-239`.

Gaps that should be covered before any migration of exception handling:

- Add a regression test proving a plugin secret replacement does **not** call the generic auto-save mutation while typing, and only persists after an explicit commit; also verify failed replacement preserves the local draft without exposing the old secret.
- Add a regression test requiring confirmation before memory bulk soft-delete, matching purge/empty-trash behavior.
- Add OAuth device-input tests for pending submission, rejected input, duplicate submission, and retry feedback.
- Add a host contract test for risk-labelled plugin fields so a high-risk manifest value cannot silently use ordinary auto-save without an explicit policy.
- Add MCP tests documenting whether environment values are credentials and, if so, whether masking/replacement is required.
- No test command was run for this audit-only report; findings are based on source and existing focused tests.

# Recommended migration notes

- Add an explicit secret-commit boundary to `usePluginConfigDraft` or split secret fields onto a commit-only path. Keep the existing masked/presence-only rendering, and retain the shared auto-save path for non-secret plugin settings.
- Treat `PluginConfigField.type === 'secret'` as a persistence policy, not merely a renderer type. The policy should prevent debounce, flush-on-close, and unmount persistence for uncommitted secret input.
- Route all destructive memory bulk actions through the existing `ConfirmDialog`; keep soft-delete, purge, and empty-trash distinctions visible in their copy.
- Extend the exception contract with a risk/side-effect policy for manifest fields. A risk badge alone is not enough if it does not alter persistence behavior.
- Preserve the established backend-driven consent pattern for plugin grants and diagnostics capture; do not replace it with optimistic toggles or client-invented grant lists.
- Keep uploads, OAuth, provider verification, and device permissions as explicit action/state machines with their own pending, success, and error feedback instead of forcing them into generic auto-save UX.
