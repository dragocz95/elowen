# Scope

Audit of every settings surface, drawer, modal, picker and form implemented under `web/modules/settings` and mounted by the `/settings` route. Read-only diagnostics, catalogs and destructive confirmations are inventoried so they are not mistaken for editable settings. The shared `MarkdownAssetEditor` is included as a module-level form even though it is not mounted directly by `/settings`.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Settings route shell, section navigation and page-level save feedback | `web/app/settings/page.tsx:110-186, 369-384, 472-517` | Category is persisted in local storage and URL; section feedback is aggregated into the hero `AutoSaveStatus`. | N/A |
| System: auto-update toggle and push-contact input | `web/app/settings/page.tsx:744-757, 285-292` | Both are seeded once and persisted with `useAutoSaveStatus`; immediate delay is used for the toggle, normal debounce for the text input. Errors are surfaced through the shared section status and toast. | Compliant |
| System: token-TTL drawer | `web/app/settings/page.tsx:759-806`, `web/app/settings/page.tsx:272-276`, `web/modules/settings/DaysPolicyEditor.tsx:8-59` | Presets and valid custom values update local state; the page autosaves `security.tokenTtlDays`, including a flush-safe shared debounce. The drawer itself has no saving/saved/error indicator; feedback is behind the overlay in the page hero. | Partial |
| System: conversation-retention toggle and days drawer | `web/app/settings/page.tsx:772-833, 250-269` | Toggle writes immediately; preset/custom day commits write immediately and invalid custom input reverts without writing. Failures toast and the custom editor restores the previous day value, but no shared status/retry control is shown in the drawer. | Partial |
| System: allowed skins picker | `web/modules/settings/SkinsRow.tsx:31-48, 87-98` | `ManageSelectionModal` keeps a local multi-selection until an explicit `Save` and then calls `update.mutateAsync({ allowedSkins })`; failure only produces a toast. This is a simple allowlist, not a secret, destructive action or multi-step transaction. | Missing |
| Models: enabled/hidden presets, custom models and notes | `web/app/settings/page.tsx:272-292, 312-353, 597-628` | Model toggles, add/edit results and notes update local state and are autosaved through the page-level controllers. Model notes use their own modal autosave and flush on close. | Compliant |
| Models: context-window override modal | `web/modules/settings/ContextWindowModal.tsx:12-52`, `web/app/settings/page.tsx:668-675` | Valid numbers and “Use default” are debounced autosaved; invalid input is held; close flushes pending work. Saving/saved/error+retry is visible in the modal footer. | Compliant |
| Models: add/edit model modal | `web/modules/settings/ModelModal.tsx:15-111`, `web/app/settings/page.tsx:648-655` | Composite label/provider/model editing uses an explicit `Save`; the parent applies the complete record and the page autosaves the resulting model snapshot. | Explicit-save justified |
| Models: delete confirmation | `web/app/settings/page.tsx:910-937` | Destructive model deletion requires confirmation, then updates the autosaved model snapshot. | Explicit-save justified |
| Brain runtime: assistant name and max-steps slider | `web/modules/settings/BrainRuntimeSection.tsx:28-52, 161-183` | Seed-once local drafts with debounced autosave and validation. Status is aggregated at the Settings hero by `onSaveState`. | Compliant |
| Brain runtime: limits drawer | `web/modules/settings/BrainRuntimeSection.tsx:54-78, 186-226`, `web/modules/settings/BrainLimitsModal.tsx:68-133` | Slider edits flow into the parent draft and autosave the whole limits object; daemon clamps are compared and displayed. The modal has only `Done`; save status/retry is outside it in the section hero. | Partial |
| Brain runtime: runtime-limits drawer | `web/modules/settings/BrainRuntimeSection.tsx:80-141, 194-234`, `web/modules/settings/RuntimeLimitsModal.tsx:79-178` | Numeric and runtime-toggle edits autosave the runtime snapshot; clamped values are reported. The modal has no local save status/retry control. | Partial |
| Brain runtime: memory-retention drawer | `web/modules/settings/BrainRuntimeSection.tsx:80-141, 210-255`, `web/modules/settings/MemoryRetentionModal.tsx:35-167` | Toggle and sliders mutate the shared runtime draft and are persisted by the runtime autosave, with clamp reporting. The modal has no visible autosave status/retry. | Partial |
| Brain runtime: tool-loading policy drawer | `web/modules/settings/BrainRuntimeSection.tsx:202-247`, `web/modules/settings/ToolDeferralModal.tsx:67-73, 146-161, 247-251` | All controls remain local until one explicit runtime patch. This preserves an atomic global/source/tool policy; save errors keep the modal open and are retryable by pressing `Save` again. | Explicit-save justified |
| Brain providers: hidden OAuth-account selector | `web/modules/settings/BrainProvidersSection.tsx:420-437` | Hiding/showing a disconnected account type calls `updateConfig` immediately, with a toast on error. There is no autosave status, retry action or optimistic local state. | Partial |
| Brain providers: OAuth connect dialog and code form | `web/modules/settings/BrainProvidersSection.tsx:86-146, 489-492, 673-685` | External OAuth/device-code flow with polling; pasted code is submitted explicitly to the active flow. Cancel is distinct from failure and late poll results are discarded. | Explicit-save justified |
| Brain providers: OAuth model-selection modal | `web/modules/settings/BrainProvidersSection.tsx:150-193, 656-671` | Selection is local inside `ManageSelectionModal` until `Save changes`, then the complete provider list is written immediately. This is a picker-level local commit, not an autosaved field, and has no save status. | Partial |
| Brain providers: API provider form | `web/modules/settings/BrainProvidersSection.tsx:196-379, 450-485, 647-655` | Endpoint, provider type, models, compatibility and optional secret are validated and submitted as one complete provider entry via explicit `Save`; the modal blocks duplicate submits and remains open on failure. | Explicit-save justified |
| Brain providers: provider compatibility modal | `web/modules/settings/ProviderCompatibilityModal.tsx:62-165`, `web/modules/settings/BrainProvidersSection.tsx:291-314, 367-375` | Local compatibility/temperature draft is committed with `Done` back into the provider form; the outer provider form persists the complete provider atomically. | Explicit-save justified |
| Brain providers: disconnect/remove confirmations and hosted-search verification | `web/modules/settings/BrainProvidersSection.tsx:494-509, 688-707` | Disconnect/remove are destructive confirmations; hosted-search verification is an external probe/reporting action, not a setting edit. | Explicit-save justified |
| Memory: embedding provider/model/custom model/dimensions | `web/modules/settings/MemorySection.tsx:46-91, 142-187` | Seeded local fields autosave through `useAutoSaveStatus`; provider/model/dimensions are sent as one embedding-settings patch. Errors are reported and retry is wired to section feedback. | Compliant |
| Memory: categorization provider/model | `web/modules/settings/MemorySection.tsx:52-91, 189-207` | Seeded local fields autosave through a separate controller; picker selection commits locally first, then the field change autosaves. | Compliant |
| Dashboard/Recap toggles, frequency and provider/model selectors | `web/modules/settings/DashboardSection.tsx:34-85, 111-191` | All dashboard fields share one seed-gated debounced autosave; config and recap queries are invalidated after success. Section status exposes retry on failure. | Compliant |
| Dashboard: regenerate digest action | `web/modules/settings/DashboardSection.tsx:100-109, 127-133` | Explicit one-shot generation command; it is not persistence of a settings edit. | N/A |
| Plugins catalog: enable/disable, install, update, restore and uninstall | `web/modules/settings/PluginsSection.tsx:194-215, 274-303, 405-414` | Immediate operational mutations with busy state, cache invalidation and toasts. Uninstall/remove is confirmed; install/enable can require explicit power consent. | Explicit-save justified |
| Plugin consent dialog | `web/modules/settings/usePluginConsent.tsx:24-109` | Explicit consent for grants that extend beyond a turn; the original operation is replayed with acknowledged grants. | Explicit-save justified |
| Plugin detail: inline schema fields (boolean, number, secret replacement, model/provider/destination/catalog/timezone/token-list controls) | `web/modules/settings/PluginConfigEditor.tsx:632-760, 835-915`, `web/lib/usePluginConfigDraft.ts:37-112` | All edits update one seed-safe draft and autosave after 900 ms. Full-snapshot writes are serialized; JSON is validated; secrets already stored are never reseeded or sent empty. | Compliant |
| Plugin detail: picker-backed fields and custom-timezone modal | `web/modules/settings/PluginConfigEditor.tsx:69-149, 165-243, 276-334` | Picker selections are local until the shared picker’s `Save changes`; the resulting draft then uses the outer autosave. Custom timezone uses an explicit local `Save` before the outer autosave. | Partial |
| Plugin detail: document editors (textarea/code/prompt/JSON) | `web/modules/settings/PluginConfigEditor.tsx:577-629, 764-808, 843-865`, `web/lib/usePluginConfigDraft.ts:72-81` | Modal editors write into the shared autosaved draft; invalid JSON is held and status becomes error. The modal footer only says `Done`; autosave status/retry remains in the plugin workspace toolbar behind the modal. | Partial |
| Plugin detail: role-policy editor and deletion confirm | `web/modules/settings/PluginConfigEditor.tsx:337-425, 810-816` | Normal role edits autosave as a full draft; deletion is confirmed and uses `commitValue` immediately to avoid resurrecting a removed permission row. Errors keep the row and confirmation flow usable; pending activation is reported. | Explicit-save justified |
| Plugin detail: MCP server list editor | `web/modules/settings/PluginConfigEditor.tsx:428-528, 818-819` | Add/remove/edit operations update the shared draft and autosave as a full snapshot; the modal is cancellable before the autosave runs. | Partial |
| Plugin detail: Teams app-package download | `web/modules/settings/TeamsAppPackageSection.tsx:6-18`, `web/modules/settings/PluginConfigEditor.tsx:985-1001` | Explicit browser download of a generated ZIP; not a settings edit. | N/A |
| Plugin detail: status, tools, hooks, permissions, logs and data panels | `web/modules/settings/PluginStatusPanel.tsx:60-87`, `PluginToolsPanel.tsx:29-67`, `PluginHooksPanel.tsx:15-55`, `PluginPermissionsPanel.tsx:16-103`, `PluginLogsPanel.tsx:16-37`, `PluginDataPanel.tsx:60-67` | Read-only reporting surfaces. | N/A |
| Plugin detail: clear plugin data confirmation | `web/modules/settings/PluginDataPanel.tsx:24-55` | Destructive data wipe requires confirmation and uses a dedicated mutation. | Explicit-save justified |
| Shared markdown skill/sub-agent editor | `web/modules/settings/MarkdownAssetEditor.tsx:50-130, 167-193, 353-406` | Multi-field document create/edit remains local until explicit `Save`; validation blocks incomplete forms, mutation errors keep the drawer open, and built-in entries are read-only. It is not directly mounted by `/settings`. | Explicit-save justified |
| Data: conversation-diagnostics fullscreen workspace and capture consent | `web/app/settings/page.tsx:878-907`, `web/modules/settings/ConversationDiagnosticsModal.tsx:324-427, 432-542` | Read-only diagnostics; enabling exact provider-request capture is an explicit consented setting change and keeps the confirmation open on failure. | Explicit-save justified |
| Data: log viewer and delete confirmations | `web/app/settings/page.tsx:901-901`, `web/modules/settings/LogsModal.tsx:37-60, 251-285` | Read-only log viewer with polling/filtering; file and all-files deletion are destructive confirmed mutations. | Explicit-save justified |
| System diagnostics and OAuth usage rails | `web/app/settings/page.tsx:834-842`, `web/modules/settings/SystemDiagnostics.tsx:101-125`, `web/modules/settings/OAuthUsageRail.tsx:49-83` | Read-only metrics/status. | N/A |

# Missing or inconsistent auto-save

- **Allowed skins is the clearest missing case.** `SkinsRow` uses a plain multi-select `Save` for a two-item allowlist (`SkinsRow.tsx:38-48, 87-95`) even though the existing config mutation and autosave status infrastructure can handle it. The action is neither secret handling, destructive, consent, upload, nor an atomic multi-step form.
- **Modal feedback is inconsistent.** Brain limits, runtime limits, memory retention, token TTL, retention days, and plugin document/MCP editors autosave, but their modal footers expose only `Done`; their status is rendered in a page/workspace hero that is visually underneath the overlay. This weakens the required saving/saved/error+retry experience even though the underlying persistence is mostly race-safe.
- **Picker semantics are inconsistent with the canonical experience.** OAuth model selection, plugin catalog/timezone fields and the skins picker all require an inner `Save changes` before the actual setting mutation. For plugin fields this is only a local selection commit followed by outer autosave; for OAuth and skins it directly precedes the server mutation. The behavior is understandable, but it creates several different meanings for “Save” across settings.
- **Hidden OAuth account types use an ad-hoc immediate mutation** (`BrainProvidersSection.tsx:429-437`) without a visible saving/saved state or retry button. It should at least reuse a small immediate-save status controller or provide an optimistic state plus retryable error state.
- **Retention’s immediate saves are split from the shared status system.** `saveRetention` returns a boolean and only toasts on failure (`app/settings/page.tsx:250-269`); the row does not expose saving/saved/error+retry state and the toggle has no optimistic draft. This is weaker than the token-TTL and section autosave paths beside it.
- **Provider/API forms deliberately do not autosave secrets or incomplete atomic records.** That is not a gap, but the modal-local busy/error treatment is separate from the shared `AutoSaveStatus` vocabulary and should remain documented as an exception rather than copied to ordinary fields.

# Legitimate exceptions

- Provider creation/editing is a multi-field atomic record and may contain API credentials. Explicit `Save` avoids persisting half an endpoint/key/model combination and preserves write-only secret handling (`BrainProvidersSection.tsx:450-485`).
- OAuth/device-code connection is an externally verified credential flow and must be explicitly initiated and confirmed.
- Tool-loading policy combines global, source and per-tool overrides; one explicit patch prevents partially applied policy states (`ToolDeferralModal.tsx:67-73, 146-161`).
- Model add/edit, role-policy deletion, plugin data clearing, log deletion and plugin install/enable consent are respectively atomic record creation, destructive permission mutation, destructive data operations, destructive file operations and explicit power consent.
- Teams package generation/download and diagnostics capture consent are external/download or consent actions, not ordinary field persistence.
- Markdown skill/sub-agent documents are multi-field content records with create/update semantics; explicit submission is reasonable and errors preserve the draft.

# Reusable existing pattern

`useAutoSaveStatus` is the canonical implementation in `web/lib/useAutoSaveStatus.ts:6-105`: seed gating, bounded debounce, serialized follow-up writes, stale-response protection, flush-on-close/unmount, visible status and retry. `usePluginConfigDraft` builds the correct full-snapshot variant in `web/lib/usePluginConfigDraft.ts:37-112`, adding JSON validation and per-plugin write serialization. Section-level aggregation is already established in `DashboardSection.tsx:78-85`, `MemorySection.tsx:89-103` and `BrainRuntimeSection.tsx:143-156`; modal-specific status is demonstrated by `ModelNoteModal.tsx:24-43` and `ContextWindowModal.tsx:29-52`.

Recommended reuse for the inconsistent surfaces:

- Add the same `AutoSaveStatus` to policy drawers, with the relevant controller’s `status` and `retry` passed from the owning section.
- Convert the skins allowlist to a seed-gated `useAutoSaveStatus` controller, or use an explicit immediate mutation only if the UI also exposes saving/error/retry state.
- Keep picker-local `Save changes` only as a selection transaction; do not describe it as server persistence, and make the outer autosave status visible after the picker closes.

# Tests and gaps

Existing coverage is strong for the shared mechanics and several core paths:

- `web/tests/lib/useAutoSaveStatus.test.tsx:6-105` covers seed suppression, debounce, success/error/retry, flush, unmount and stale responses.
- `web/tests/app/settings.test.tsx:102-186` covers model autosave, retention writes, token-TTL presets/custom validation and retention failure recovery.
- `web/tests/modules/settings/BrainSection.test.tsx:38-80, 365-377` covers limits drawer autosave/clamping and memory-retention autosave; provider tests cover failed atomic saves and OAuth flows (`BrainSection.test.tsx:299-377`).
- `web/tests/modules/settings/MemorySection.test.tsx:65-102` covers picker-driven categorization autosave and embedding controls.
- `web/tests/modules/settings/PluginConfigEditor.test.tsx:174-410` covers inline fields, picker fields, document modal edits, JSON validation and serialized draft behavior; `web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105` covers invalid JSON, secret omission, immediate commit and stale full snapshots.
- `web/tests/modules/settings/ToolDeferralModal.test.tsx:56-149` covers explicit atomic saves and locked-tool invariants.
- `web/tests/modules/settings/ConversationDiagnosticsModal.test.tsx:164-239` covers capture consent success/failure and duplicate-submit protection; `LogsModal.test.tsx:57-140` covers read/error/truncation states.

Gaps relevant to this audit:

- No visible persistence test for `SkinsRow` selection, save failure or retry; its current test (`SkinsRow.test.tsx:26-94`) is layout/catalog focused.
- No direct Settings-route coverage for dashboard autosave, auto-update, push contact, or the token/retention drawer’s visible save status.
- Brain runtime name/max-steps and runtime-limit error/retry/status coverage is incomplete; current tests mostly assert draft transformation and limits clamping.
- Modal-specific status visibility is not asserted for BrainLimitsModal, RuntimeLimitsModal, MemoryRetentionModal, ToolDeferralModal or PluginConfigEditor’s modal-backed fields.
- Plugin picker tests prove the local `Save changes` contract, but do not assert that the user sees outer autosave feedback after closing the picker or that a picker mutation failure offers a retry path.
- Hidden OAuth visibility mutation has no focused test for optimistic state, failure recovery or retry.

# Recommended migration notes

1. Prioritize `SkinsRow`: seed from `config.data.allowedSkins`, update local selection on each checkbox/radio change, persist through `useAutoSaveStatus`, and keep the picker’s `Save changes` only if it is explicitly treated as a local selection commit. Add failure/retry coverage.
2. Expose autosave feedback inside every autosaving drawer/editor. The owning section should pass status/retry down, or the modal should receive the controller result; do not rely on a hero hidden behind the overlay.
3. Normalize immediate single-field mutations such as retention and hidden OAuth visibility around the same visible status/retry contract, while retaining immediate writes where they are semantically appropriate.
4. Preserve explicit-save exceptions for credentials, consent, destructive actions, downloads and genuinely atomic multi-field records; document them in UI/API contracts so future audits do not convert them blindly.
5. Add focused regression tests for modal status visibility, skins autosave, hidden-OAuth failure recovery, dashboard/system autosaves, and picker-to-outer-autosave feedback.
