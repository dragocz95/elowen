# Scope

Audit of host web settings and related drawers/overlays for brain identity, providers, model catalogs and selection, runtime policy, limits, compaction, and persistence semantics under `/var/www/elowen/web`. The audit covers validation, loading/error handling, autosave status, stale-draft protection, and focused tests. The daemon remains the validation authority; this report evaluates the web boundary and does not change code.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Settings → Elowen AI: agent name and max steps | `web/modules/settings/BrainRuntimeSection.tsx:28-52,161-183` | Local drafts use `useAutoSaveStatus`; name is trimmed before `PUT /api/config`, and max steps are floored/clamped to `1..1000`. The section reports aggregate status to the settings hero (`:143-156`). | Partial |
| Brain limits modal | `web/modules/settings/BrainLimitsModal.tsx:35-69,88-132`; parent save `BrainRuntimeSection.tsx:54-78` | Slider edits update the parent draft and autosave the whole `brain.limits` record. Canonical unit conversion and min/max bounds mirror daemon bounds; applied server clamps are shown per field. No Save button. | Compliant |
| Runtime limits and runtime feature toggles | `web/modules/settings/RuntimeLimitsModal.tsx:38-81,101-178`; parent save `BrainRuntimeSection.tsx:80-141` | Slider/toggle edits update one runtime draft. Autosave sends the runtime/retention-owned fields, serializes through the shared hook, and reports server-applied clamps. Tool-loading and hosted-search fields are deliberately excluded to avoid stale-draft replay. | Compliant |
| Memory-retention modal | `web/modules/settings/MemoryRetentionModal.tsx:25-37,61-167`; parent save `BrainRuntimeSection.tsx:122-138` | Toggle and sliders edit `runtime.memoryRetention` in the shared runtime draft and autosave without a Save button. Bounds, half-life sentinel `0`, and pinned importance 5 are explicit. | Compliant |
| Tool-loading policy modal | `web/modules/settings/ToolDeferralModal.tsx:67-86,146-162,171-251` | Keeps global toggle, threshold, source overrides, and tool overrides local, then submits one explicit runtime patch. Loading and save errors remain visible; failed saves keep the draft open. | Explicit-save justified |
| OAuth account rows and connect/disconnect flow | `web/modules/settings/BrainProvidersSection.tsx:513-562,673-707`; `OAuthConnectDialog` `:86-146` | Connect, disconnect, and OAuth code submission are explicit actions. Connect polls until success/error and ignores late results after cancellation. Disconnect is confirmed first. | Explicit-save justified |
| OAuth account model selection | `web/modules/settings/BrainProvidersSection.tsx:162-193,656-670` | Multi-select catalog opens a manage modal with an explicit Save; the selected list is persisted as one provider entry. This is an atomic set operation, not per-row editing. | Explicit-save justified |
| API-key provider editor and compatibility drawer | `web/modules/settings/BrainProvidersSection.tsx:196-379,450-485`; `ProviderCompatibilityModal.tsx:62-164` | Endpoint/key/models/temperature/capability flags are edited as one provider draft and committed by explicit Save. Blank API key is omitted, preserving an existing secret. Compatibility settings are staged and committed with the provider. | Explicit-save justified |
| Provider validation and endpoint probing | `web/modules/settings/BrainProvidersSection.tsx:210-231,245-351,450-468` | Client validation requires label, derived unique id, and a base URL for OpenAI-compatible providers; temperature is explicitly checked as finite `0..2`. Endpoint `/models` probing is debounced and generation-guarded, with manual model entry fallback. | Partial |
| Settings → Models: allowlist, hidden presets, custom model add/edit | `web/app/settings/page.tsx:188-237,272-288,307-353,530-655`; `ModelModal.tsx:15-111` | Allowlist/hidden presets autosave immediately (`delay: 0`); model add/edit remains an explicit atomic Save with duplicate-exec and required-field validation. The page hero combines model/context-window save statuses. | Compliant |
| Model notes drawer | `web/modules/settings/ModelNoteModal.tsx:11-45`; parent `web/app/settings/page.tsx:326-332` | Debounced autosave of a single note; empty trimmed text removes the map entry. Close flushes the pending write and the drawer has visible saved/error/retry status. | Compliant |
| Elowen model context-window drawer | `web/modules/settings/ContextWindowModal.tsx:12-55`; parent `web/app/settings/page.tsx:191-198,276-300,668-675` | Debounced autosave; blank or “Use default” clears the override, invalid values do not persist, and close flushes. The drawer has visible status/retry. | Partial |
| Account → Elowen AI: vision/compaction model, reasoning, fast mode, auto-compact, per-model thresholds, permissions | `web/modules/account/CliSection.tsx:21-58,60-76,78-157,162-294`; `CompactThresholdsDrawer.tsx:10-84` | Per-user fields use seeded local drafts, delayed or immediate shared autosave, serialized writes, retry, and section-hero status. The drawer edits global/per-model thresholds through the same parent draft. YOLO is confirmation-gated before autosave. | Compliant |
| Account profile: default Elowen AI model | `web/modules/account/AccountView.tsx:120-125,189-230,308-326,374-391` | Single selection applies an immediate PATCH with optimistic highlight and rollback on error. Pending/success/error is folded into the profile hero status and retry re-applies the current selection. | Partial |
| Advisor runtime model picker | `web/modules/advisor/ModelModal.tsx:10-35`; picker rows `BrainModelField.tsx:7-61` | Selection is a session/runtime action that switches the conversation and closes; it is not a settings persistence surface. | N/A |

# Missing or inconsistent auto-save

- **Provider saves are absent from the Brain section’s visible save-state channel.** `BrainSection` passes `onSaveState` only to `BrainRuntimeSection` (`BrainSection.tsx:10-18`), while `BrainProvidersSection` uses toast callbacks and local `providerSavePending` (`BrainProvidersSection.tsx:381-448`). Provider Save disables the form and uses `aria-busy`, but there is no shared “saving/saved/error + retry” status in the Brain hero. This is acceptable for an explicit atomic provider Save only if the modal feedback is intentionally the contract; it is inconsistent with the rest of the page.
- **OAuth visibility toggles are immediate writes without a status lifecycle.** `setHiddenOauth` calls `mutateAsync` and only emits an error toast (`BrainProvidersSection.tsx:429-437`). The action has no saving/saved state or retry affordance. A single toggle is a good candidate for immediate mutation, but it should use the same visible status/retry pattern as other immediate settings.
- **Context-window autosave has no server-effective-value feedback.** The input accepts any finite integer `>=1` (`ContextWindowModal.tsx:26-31`), while the parent floors and drops values below one (`app/settings/page.tsx:293-300`). There is no upper bound, no comparison to the daemon’s effective response, and no indication if the daemon clamps/rejects a value. Brain/runtime limit editors already report applied values (`BrainRuntimeSection.tsx:58-75,115-138`), so this surface is the inconsistent one.
- **The profile default-model mutation is not serialized.** `applyElowen` calls `saveModel.mutate` directly for each selection (`AccountView.tsx:217-230`). It has optimistic rollback and hero status, but unlike `useAutoSaveStatus` it has no stale-response/queued-write protection if a user changes the selection again before the first PATCH settles. Rapid picks could leave the server and highlight out of order.
- **Max-steps UI bounds do not match the stated accepted range.** The save path clamps `1..1000` (`BrainRuntimeSection.tsx:40-52`), but the only control is a slider with `min={100}` and `step={100}` (`:174-177`). An existing server value such as 20 is displayed while the slider’s effective controlled value is forced to 100 (`:176-182`), and the user cannot intentionally choose values 1–99 through this UI. This is a validation/contract mismatch rather than a lost-write bug.
- **Provider client validation is deliberately shallow.** The provider form validates non-empty fields and temperature, but does not validate URL syntax, model identifiers, or provider-specific compatibility combinations before Save (`BrainProvidersSection.tsx:210-210,450-468`). The daemon can reject these, but the user receives the failure only after an explicit submission. The endpoint probe is helpful, not a substitute for a clear URL/field error.
- **The shared hook supports a separate `savable` flag, but BrainRuntimeSection folds validity into `ready`.** The hook explicitly documents that validity should be separate from seed readiness (`useAutoSaveStatus.ts:19-24,26-31`). BrainRuntime uses `ready: ... && valid` for name and steps (`BrainRuntimeSection.tsx:35-52`). Current controls make this mostly safe, but it is less robust than the established contract if future controls become temporarily invalid: seed gating and invalid-value cancellation can drift from the hook’s intended semantics.

# Legitimate exceptions

- API-key provider editing should remain an explicit atomic Save: it includes a secret, endpoint, model list, wire API, temperature, and compatibility capabilities. The current implementation omits a blank key and keeps the complete draft after failure (`BrainProvidersSection.tsx:450-485`; `ProviderModal.tsx:245-365`).
- Tool-loading policy is a bulk policy editor with global, source, and per-tool overrides. One explicit patch avoids half-applied policy changes and makes Cancel meaningful (`ToolDeferralModal.tsx:67-86,146-162`).
- OAuth connect/disconnect and code entry are externally verified credential/account operations; they must not autosave credentials or silently connect/disconnect.
- OAuth model multi-selection is an atomic set operation, so an explicit Save in `ManageSelectionModal` is justified (`BrainProvidersSection.tsx:182-193,656-670`).
- Custom model add/edit changes multiple coupled fields and must validate duplicate executable identity before committing (`ModelModal.tsx:39-43,88-109`).
- The advisor `/model` overlay changes the live conversation, not durable settings (`modules/advisor/ModelModal.tsx:10-19,21-33`), so autosave does not apply.

# Reusable existing pattern

`web/lib/useAutoSaveStatus.ts:6-24,26-105` is the canonical pattern: seed gating, bounded debounce, serialized writes, latest-callback reads, pending flush on close/unmount, visible terminal status, and retry. The strongest examples are:

- Brain runtime: one draft per owned group, response comparison for daemon clamps, and aggregate section reporting (`BrainRuntimeSection.tsx:54-156`).
- Account CLI: independent autosave lifecycles for settings and permissions, with `savable`/`ready` separated and aggregate retry (`CliSection.tsx:96-157`).
- Profile fields: per-field baseline/diff tracking prevents refetches from overwriting unsaved edits (`AccountView.tsx:141-187`).
- Models page: local state is seeded once, model/context saves are independently tracked, and the hero exposes combined status (`app/settings/page.tsx:221-237,272-288,368-375,472-480`).

# Tests and gaps

Existing focused coverage is useful but uneven:

- `web/tests/modules/settings/BrainLimitsModal.test.tsx` covers unit conversion, canonical bounds, daemon-clamp messaging, and help-layer geometry.
- `web/tests/modules/settings/RuntimeLimitsModal.test.tsx` covers unit conversion, bounds, clamp messaging, and runner toggle isolation.
- `web/tests/modules/settings/BrainSection.test.tsx` covers OAuth catalogs/connect cancellation, stale probe responses, provider temperature zero, provider failure retention, hosted-search verification, and retention autosave (`:120-377`).
- `web/tests/app/settings.test.tsx` covers model allowlist autosave and several system settings, but not the full Models editor path (`:85-109` is the relevant allowlist coverage).
- Account CLI tests cover model picker persistence and related settings, while the source shows the complete status/retry composition (`CliSection.tsx:117-157`).

Not covered or not demonstrated by the inspected focused tests:

- Brain agent-name and max-steps autosave, invalid/blank transitions, and the max-steps 1–99 contract mismatch.
- Brain/runtime whole-record autosave serialization, retry, close/category-switch flush, and stale server response behavior.
- ToolDeferralModal load failure, explicit-save retry, Cancel preservation, and stale runtime changes while open.
- Provider hidden-OAuth write failure/status, duplicate id and malformed URL validation, and provider status visibility in the Brain hero.
- ContextWindowModal autosave, invalid input suppression, clear/default behavior, flush-on-close, and server clamp/rejection handling; no matching focused test file was found under `web/tests`.
- ModelNoteModal autosave, trim/clear behavior, flush-on-close, and retry; no matching focused test file was found under `web/tests`.
- Rapid successive default-model selections in `AccountView.applyElowen` and out-of-order mutation responses.

# Recommended migration notes

- Decide whether Brain provider operations intentionally remain modal-scoped explicit saves. If yes, expose their pending/error/retry state in the modal and document that the Brain hero reports runtime-only status; otherwise add a provider save-state callback and combine it with the runtime status.
- Route OAuth visibility toggles through a small immediate-save status controller with serialized writes and retry, rather than fire-and-forget mutation plus toast only.
- Add effective-value handling for `modelContextWindows`: validate against the daemon contract, compare the response, and show a clamp/rejection message using the existing applied-value pattern.
- Serialize default-model PATCHes or reuse the shared autosave controller with `delay: 0`, while retaining optimistic selection and rollback.
- Align max-steps UI with the actual `1..1000` contract (either expose 1–1000 or intentionally narrow and document the daemon/UI distinction); add a regression test for seeded values below the slider minimum.
- Add focused regression tests for the missing drawers and status/error paths before migrating any further host settings. Preserve explicit Save for secrets, externally verified OAuth operations, bulk policy edits, atomic multi-field provider/model edits, and multi-select sets.
