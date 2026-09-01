# Scope

Audit of the host web surfaces for Marketplace browsing, installed plugin management, plugin detail/configuration, enable/install consent, and destructive plugin actions. The audited implementation is under `/var/www/elowen/web`; plugin-bundle implementations outside the host are treated as an integration boundary, not assumed compliant.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Marketplace **Available** tab: search, category filter, available cards, Install, bundled-plugin Restore | `web/modules/settings/PluginsSection.tsx:147-197, 237-269, 318-401`; `web/lib/queries.ts:297-299` | Search/category/view are local UI state. Install and Restore are explicit immediate mutations; cards are disabled while the section-level `pending` name matches. Install is routed through the shared grant-consent hook. | Compliant |
| Installed plugin list: enable/disable toggle, Update, Uninstall/Remove, context menu | `web/modules/settings/PluginsSection.tsx:81-145, 274-316, 348-415`; `web/lib/mutations.ts:130-187` | Enable is an immediate optimistic PATCH with rollback and query invalidation. Update, uninstall, and restore are explicit mutations with success/error toasts and list/catalog invalidation. Uninstall is confirmed before mutation. | Partial |
| Plugin detail hero and enable toggle | `web/modules/settings/PluginDetail.tsx:94-111, 161-171`; `web/modules/settings/PluginSummary.tsx:8-39`; `web/modules/settings/PluginActions.tsx:9-31` | Enable/disable is the same immediate, consent-gated mutation as the list. The detail has loading and retryable error states. | Compliant |
| Plugin detail setup/behavior/advanced configuration, inline fields | `web/modules/settings/PluginDetail.tsx:114-154`; `web/modules/settings/PluginConfigEditor.tsx:632-760, 835-1015` | Schema-driven edits update one shared draft. The draft debounces a full snapshot by 900 ms, validates JSON, serializes writes, and exposes saving/saved/error/retry state in the detail toolbar. | Compliant |
| Modal-backed config fields: textarea, code/prompt, JSON, selectors, timezone, token lists, projects/plugins/tools/models | `web/modules/settings/PluginConfigEditor.tsx:51-109, 111-149, 165-243, 250-335, 577-629, 764-823` | Modal controls write into the same shared draft; selecting or typing autosaves. `Done` only closes the editor and is not a second Save action. Custom timezone and searchable pickers correctly feed the draft. | Partial |
| Structured role-policy editor and role deletion | `web/modules/settings/PluginConfigEditor.tsx:337-425`; `web/tests/modules/settings/PluginConfigEditor.test.tsx:94-122` | Add/edit operations autosave through the shared draft. Removing a role is an explicit destructive confirmation and commits the replacement immediately; failure keeps the dialog open and the controlled draft unchanged. | Explicit-save justified |
| MCP server list/editor | `web/modules/settings/PluginConfigEditor.tsx:428-527, 810-820` | Add, edit, toggle, and remove update the shared autosaved draft. There is no separate form Save button. | Compliant |
| Plugin health, capabilities, permissions, hooks, activity/logs | `web/modules/settings/PluginStatusPanel.tsx:60-87`; `web/modules/settings/PluginToolsPanel.tsx:29-67`; `web/modules/settings/PluginHooksPanel.tsx:15-55`; `web/modules/settings/PluginPermissionsPanel.tsx:16-103`; `web/modules/settings/PluginLogsPanel.tsx:16-37` | Read-only derived/query-backed panels. Logs poll every 3 seconds while detail is open (`web/lib/queries.ts:262-266`). No persistence action is present. | N/A |
| Plugin data clear | `web/modules/settings/PluginDataPanel.tsx:24-67`; `web/lib/elowenClient.ts:142-143` | Destructive immediate POST behind a confirmation dialog; the action is disabled while pending and success/error is surfaced by toast. | Explicit-save justified |
| Capability consent for enable and marketplace install | `web/modules/settings/usePluginConsent.tsx:24-109`; `web/lib/elowenClient.ts:127-135, 153-166`; `web/modules/settings/PluginsSection.tsx:201-212` | The daemon’s 409 grant list is rendered verbatim/translated in a confirmation dialog, then the same mutation is replayed with `acknowledgeGrants`. Install may already be on disk but inert when consent is declined. | Partial |
| Host route for plugin-owned browser pages/settings | `web/app/p/[plugin]/[[...rest]]/page.tsx:25-151`; `web/lib/pluginUi.tsx:146-197, 338-349` | Host exposes `useAutoSaveStatus`, `usePluginConfigDraft`, `AutoSaveStatus`, and `useSavePluginConfig`; page settings receive a host save-state channel and render it in the page header. Bundle-specific forms are outside this host audit. | N/A |

# Missing or inconsistent auto-save

- **Consent confirmation can be submitted repeatedly while the mutation is in flight.** `usePluginConsent.confirm` calls `installPlugin`/`setEnabled` but returns `void` (`web/modules/settings/usePluginConsent.tsx:94-98`), so `ConfirmDialog` does not enter its promise-backed pending state. The dialog remains open until the mutation callback clears it (`:100-108`), and `usePluginConsent` exposes busy state only for toggle mutations (`:115`), not installs. Repeated confirmation clicks can issue duplicate install/enable requests. Add a single in-flight guard and pass a pending/disabled state to the consent dialog; add a regression test.
- **Declining install consent can leave the Marketplace view stale.** The daemon can install the plugin inert before returning the grant refusal (`web/modules/settings/usePluginConsent.tsx:27-31`), but the install mutation invalidates plugin views only on success (`web/lib/mutations.ts:169-173`). The consent error path only opens the dialog (`web/modules/settings/usePluginConsent.tsx:82-91`), so cancelling can leave the catalog showing the plugin as available and the installed list empty until an unrelated refresh. On a grant refusal carrying `installed: true`, invalidate Marketplace and installed-plugin queries before/when closing the dialog.
- **Autosave feedback is outside modal-backed editors.** `PluginDetail` renders `AutoSaveStatus` only in the workspace toolbar (`web/modules/settings/PluginDetail.tsx:102-112`), while `ModalFieldRow` renders the modal with only a `Done` footer (`web/modules/settings/PluginConfigEditor.tsx:620-625`). During a code/text/JSON/selector edit, the overlay can obscure the only saving/saved/error+retry indicator. Invalid JSON is visible inside the editor, but a server-side save failure is not. Put the shared status/retry control in the modal footer as well, or otherwise make the active editor’s save state visible without closing it.
- **Immediate management actions do not offer retry.** Update, uninstall, restore, and data-clear use disabled/busy affordances plus toasts (`web/modules/settings/PluginsSection.tsx:278-302`; `web/modules/settings/PluginDataPanel.tsx:31-55`), but a transient failure requires reopening the action manually. This is acceptable for explicit commands, but it is less consistent than the config autosave contract and should be a deliberate product choice.
- **No host-level evidence covers custom plugin-bundle settings.** The host publishes the correct primitives and save-state callback (`web/lib/pluginUi.tsx:338-349`; `web/app/p/[plugin]/[[...rest]]/page.tsx:105-129`), but compliance depends on each registry bundle using them. A contract/e2e check should verify that registered plugin settings expose autosave status and do not introduce Save-only forms.

# Legitimate exceptions

- Enable, install, update, restore, uninstall/remove, and clear-data are imperative operator actions, not ordinary editable settings. Immediate mutations are appropriate; they should not be converted into debounced autosave.
- Plugin enable/install consent is intentionally explicit because it grants declared powers such as tools, memory, events, or workflow access. The daemon remains authoritative and the UI submits exactly the returned grant list (`web/modules/settings/usePluginConsent.tsx:65-88`).
- Role-policy removal changes platform permissions and is destructive; confirmation plus immediate commit is justified (`web/modules/settings/PluginConfigEditor.tsx:354-361, 413-422`).
- Stored secrets are never read back and require an explicit Replace action (`web/modules/settings/PluginConfigEditor.tsx:869-901`). This is a security-sensitive exception, not a missing autosave path.
- Clearing plugin data deletes the plugin data directory contents and must remain behind confirmation (`web/modules/settings/PluginDataPanel.tsx:24-55`; `web/lib/elowenClient.ts:142-143`).

# Reusable existing pattern

- `useAutoSaveStatus` is the canonical controller: it skips the seed value, debounces edits, serializes follow-up writes, flushes pending work on teardown, and exposes `saving`, `saved`, `error`, and retry states (`web/lib/useAutoSaveStatus.ts:7-30, 45-105`).
- `usePluginConfigDraft` is the canonical plugin-config adapter: one shared draft, 900 ms debounce, JSON validation, serialized full-snapshot writes, stale-refetch protection, and immediate confirmed commits for destructive structured edits (`web/lib/usePluginConfigDraft.ts:37-112`).
- `AutoSaveStatus` provides the standard accessible presentation and retry affordance (`web/components/ui/AutoSaveStatus.tsx:7-26`).
- Config mutation success refreshes plugin detail, installed list, and brain commands (`web/lib/mutations.ts:283-288`), while enable/install/update/restore/uninstall refresh the relevant plugin views (`web/lib/mutations.ts:151-187`).
- The host plugin runtime publishes the same autosave hook/components to bundles, avoiding a second persistence protocol (`web/lib/pluginUi.tsx:294-305, 338-349`).

# Tests and gaps

Existing focused coverage is strong for the normal paths:

- Marketplace listing, search/filter, update, uninstall confirmation, install, grant consent, and install consent: `web/tests/modules/settings/PluginsSection.test.tsx:38-240`.
- Detail loading/error, selectors, required setup, modal fields, JSON handling, secret replacement, and autosaved config writes: `web/tests/modules/settings/PluginDetail.test.tsx:84-527`.
- Role deletion confirmation, persistence failure, and delayed activation: `web/tests/modules/settings/PluginConfigEditor.test.tsx:94-122`.
- Generic debounce, retry, unmount flush, activity hide/show, and stale-response protection: `web/tests/lib/useAutoSaveStatus.test.tsx:6-102`.

Gaps to close:

- No test double-clicks the grant-confirm button while install/enable is pending.
- No test declines install consent after the daemon reports `installed: true` and verifies catalog/list cache refresh.
- No test asserts that save failure is visible and retryable while a modal-backed config editor remains open.
- No focused test covers update/install failure recovery beyond toast behavior or verifies any 202/delayed activation response for management actions.
- This audit inspected source and tests but did not execute the test suite in the delegated read/write environment.

# Recommended migration notes

1. Fix consent mutation ownership first: expose combined install/toggle pending state, make the confirmation callback promise-backed or explicitly lock it, and prevent duplicate submissions.
2. Treat an install grant refusal with `installed: true` as a committed inert-install state and invalidate both Marketplace and installed-plugin queries when consent is declined or dismissed.
3. Surface the draft’s `AutoSaveStatus` inside modal-backed editors, preserving the workspace toolbar indicator as the page-level summary.
4. Add focused regressions for the three cases above before changing shared autosave code; the existing `useAutoSaveStatus` and `usePluginConfigDraft` mechanisms should remain the single source of truth.
5. Add a plugin-bundle contract/e2e assertion around the published autosave primitives and `onSaveState` channel rather than auditing each bundle by visual similarity.
