# Web UI control audit

## Scope and standard

This audit covers the core web modules (Settings, Account, Users, Projects, Memory, Dashboard, and chat overlays), the generic plugin renderer, bundled manifests in `plugins/`, and the installed plugin sources under `/var/www/.config/elowen/plugins-data/sandbox/users/1/workspaces/elowen-plugins-fast-v3/plugins/`.

The standard is simple: a person should select known entities and known finite values, adjust bounded quantities in meaningful units, and manage collections as visible items. Free text remains appropriate for prose, arbitrary identifiers, commands, URLs, glob patterns, provider-defined values, and genuinely open-ended model identifiers. Existing `Slider`, `Toggle`, `Segmented`, `ChoiceField`, `SelectMenu`, `BrainModelField`, `ManageSelectionModal`, `SelectionSummary`, `ConfirmDialog`, `Field`, and `DirectoryPicker` establish the house patterns.

Verification result: the path references were checked against the current core and installed-plugin workspaces; the findings below marked **Verified** still match the code, while the **Correction** notes narrow or withdraw claims that treated a stylistic preference as a UX defect.

## Findings

### Settings — generic plugin configuration

#### Bounded numeric settings lack unit-aware control metadata

- **Files:** `web/modules/settings/PluginConfigEditor.tsx:458-464`; manifest examples: `plugins/mcp/elowen-plugin.json:71-90`, `plugins/terminal/elowen-plugin.json:39-69`, `plugins/files/elowen-plugin.json:53-94`, `plugins/subagent/elowen-plugin.json:63-88`; installed `cronjob/elowen-plugin.json:50-150` and `codebase/elowen-plugin.json:49-171`.
- **Correction:** the original claim that every bounded number should become a slider was too broad. A range such as `10,000–500,000` in steps of `1,000` needs precise entry more than pointer dragging, while small sets such as retry attempts `1–5` are good slider or segmented candidates.
- **Today:** every manifest field of type `number` becomes the same `<Input type="number">`. The schema can describe min/max/step but cannot describe display units, formatting, presets, or whether a slider is appropriate, so milliseconds, bytes, characters, percentages, and counts all read as raw storage values.
- **Instead:** add display metadata such as unit, scale/formatter, and preferred control. Use `Slider` plus a formatted readout for low-cardinality or coarse bounded values; retain `Input type="number"` for wide or precision-oriented ranges, but show human units and optionally offer presets.
- **Existing component:** `web/components/ui/Slider.tsx`; readout pattern in `web/modules/settings/RuntimeLimitsModal.tsx:93-131`; `ChoiceField` for short preset sets.
- **Effort / impact:** **medium / high.** One renderer enhancement makes many plugin settings legible without replacing precise inputs with imprecise controls.

#### Some number schemas omit useful validation and unit treatment

- **Files:** `plugins/web/elowen-plugin.json:49-53`; installed `onedrive/elowen-plugin.json:39-50` and `web/elowen-plugin.json:9-12`.
- **Correction:** not every field needs an arbitrary maximum. OneDrive's largest-file policy and sync interval are operator-dependent, so inventing tight maxima would be false guardrails.
- **Today:** `maxResults`, OneDrive sync interval, and largest file are raw numeric inputs with no declared minimum, step, or display metadata. `maxResults` has a naturally small safe range; the OneDrive fields at least have natural lower bounds and human units even if their upper policy limit remains open.
- **Instead:** declare the defensible constraints: a bounded result count, positive whole seconds, and positive MB. Feed those through the unit-aware renderer above; leave genuinely policy-dependent maxima unset.
- **Existing component:** `Input` with schema-backed `min`/`step`, or `Slider`/`ChoiceField` only where a real bounded set exists.
- **Effort / impact:** **small / medium.** Prevents invalid low values and makes routine tuning understandable without pretending every policy has one correct ceiling.

#### Several generic text controls have no accessible name

- **Files:** `web/modules/settings/PluginConfigEditor.tsx:378-402`, `464-470`, `551-583`.
- **Today:** `LabeledField` renders its caption as a visual `<span>`, not a `<label>`. The number input supplies `aria-label`, but the default string input, textarea, secret input, prompt/code editor, and JSON textarea do not consistently receive an accessible name from the manifest label.
- **Instead:** connect every simple control to its caption through `Field`'s control props or assign the same `fieldLabel(f)` as an explicit accessible label. Monaco editors need an equivalent `ariaLabel` option rather than relying on surrounding text.
- **Existing component:** `Field`; the number-field `aria-label` at `PluginConfigEditor.tsx:463` is the minimal pattern to apply where `Field` cannot wrap the editor.
- **Effort / impact:** **small / high.** Fixes a schema-wide keyboard and screen-reader gap across third-party settings.

### Settings — Brain, memory, and system

#### Temperature has two incompatible editors

- **Files:** `web/modules/settings/BrainProvidersSection.tsx:301-310`; `web/modules/settings/ProviderCompatibilityModal.tsx:108-134`.
- **Verification:** **Verified.** The same `0–2` temperature value is a typed number in the normal provider form and an optional toggle plus slider in the compatibility drawer.
- **Today:** the control model changes according to which provider path is open, even though an empty value means “do not override” in both cases.
- **Instead:** use the compatibility drawer's toggle-and-slider treatment in both paths, or route both paths through one temperature editor.
- **Existing component:** `Slider` and `Toggle`.
- **Effort / impact:** **small / medium.** Removes a visible inconsistency and makes the optional override state explicit.

#### Token TTL and session retention need clearer units, not forced sliders

- **Files:** `web/app/settings/page.tsx:640-643`, `647-685`; backend validation at `src/store/configStore.ts:226-229`.
- **Correction:** the original slider recommendation was wrong. Both values are intentionally unbounded whole-day policies (`>= 1`), and the backend has no sensible maximum to map onto a range control. Retention is also already managed in a dedicated drawer rather than as the previously described inline bare input.
- **Today:** token TTL is a bare number with its unit only in help copy. Session retention shows `days` in the drawer, but policy-oriented values still require typing and have no quick presets.
- **Instead:** keep precise numeric entry, put `days` directly beside token TTL as retention already does, and offer optional `ChoiceField` presets such as 7/30/90/365 with a Custom path. Do not impose a slider maximum.
- **Existing component:** `ChoiceField` plus `Input` for Custom.
- **Effort / impact:** **small / medium.** Improves comprehension and speed without narrowing a legitimate unbounded policy.

#### Embedding dimensions are correctly left as an advanced optional number

- **Files:** `web/modules/settings/MemorySection.tsx:172-188`; explanatory copy in `web/lib/i18n/dictionaries/en.ts:1770`.
- **Correction:** this finding is withdrawn as factually wrong. The valid dimension is model/provider-dependent and may be omitted to use the model default; the client does not own a reliable finite catalog. A fixed segmented list would create false confidence and could break custom embedding providers.
- **Current control:** the optional numeric escape hatch is appropriate. A future provider catalog may prefill a known dimension, but free numeric entry must remain available.
- **Effort / impact:** **none.** No change recommended without authoritative model metadata.

### Projects

#### Editing an existing project path loses the picker available on creation

- **Files:** `web/modules/projects/ProjectsView.tsx:391-397` versus `431-433`; `web/modules/projects/DirectoryPicker.tsx:10-54`.
- **Verification:** **Verified.** Creation pairs the path input with **Browse**, while Edit Project exposes only typed absolute-path entry.
- **Instead:** expose the same `DirectoryPicker` next to the edit path and initialize it from `editPath`.
- **Existing component:** `DirectoryPicker`.
- **Effort / impact:** **small / high.** Eliminates an error-prone server-path edit with an existing control.

#### Cancelling project removal discards the edit draft

- **Files:** `web/modules/projects/ProjectsView.tsx:410-445`, `458-467`.
- **Today:** clicking **Remove project** first clears `editProject`, then opens a separate confirmation. Cancelling that confirmation returns to the project screen, not the edit modal, so unsaved path or notes edits are lost even though no project was removed.
- **Instead:** keep the edit modal and draft mounted while a centered confirmation sits above it, or restore the edit state on cancellation. Only clear the edit draft after confirmed deletion succeeds or the user explicitly cancels editing.
- **Existing component:** `ConfirmDialog` already supports a centered nested confirmation and the shared overlay stack prevents backdrop clicks from closing the parent.
- **Effort / impact:** **small / high.** Prevents silent input loss on the destructive path.

### Users and account

#### Administrator role changes have no confirmation, including self-demotion

- **Files:** `web/modules/users/UsersView.tsx:94-111`, `122-139`.
- **Today:** **Make admin** and **Remove admin** execute immediately from the action menu/context menu. The action is also offered for the signed-in administrator, who can remove their own admin access without any explanation of the resulting permission loss.
- **Instead:** confirm role elevation and revocation, naming the user and stating that admin access changes immediately. Make self-demotion copy explicit about losing access to Users, instance settings, and other owner-only operations.
- **Existing component:** `ConfirmDialog`.
- **Effort / impact:** **small / high.** Adds a safety gate around privilege expansion and accidental lockout.

#### User-management failures are printed as implementation errors

- **Files:** `web/modules/users/UsersView.tsx:50-76`.
- **Today:** create, delete, and role-update failures call `toast(String(err), 'error')`, which can expose strings such as `Error: api 409 on /users` instead of explaining the conflict or refused permission. The form correctly keeps its input, but the feedback is not actionable.
- **Instead:** map API error codes/statuses to specific translated messages and use a generic user-management fallback. Preserve the current retained form state.
- **Existing component:** `Toast`; error-shaping precedent is `ElowenApiError` handling in `web/modules/account/AccountView.tsx:280-290` and `apiErrorMessage` elsewhere.
- **Effort / impact:** **small / medium.** Turns failed operations into recoverable decisions instead of backend leakage.

### Chat overlays and diagnostics

#### Native task-status select is appropriate; no replacement is needed

- **Files:** `web/modules/advisor/TasksModal.tsx:119-129`; `web/components/ui/SelectMenu.tsx:16-145`.
- **Correction:** the original finding is withdrawn as a UX defect. A native `<select>` is compact, labelled, keyboard-capable, and receives strong platform behavior on mobile for exactly three plain values. Replacing it solely for visual consistency would not improve the task flow.
- **Current control:** keep the native select unless the product later needs icons, descriptions, or richer status semantics.
- **Effort / impact:** **none.** No change recommended.

#### Diagnostics filters are correctly mixed between finite selects and open server queries

- **Files:** `web/modules/settings/ConversationDiagnosticsModal.tsx:178-183`, `221-254`.
- **Correction:** the original recommendation to populate provider/model pickers from loaded sessions was incomplete. The session rail is paginated, while these filters query historical server data; a client-built option list would omit values not loaded on the current page. Native selects are also valid controls for the finite surface/status sets.
- **Today:** surface and status use labelled native selects; provider and model remain free text so an operator can query values outside the currently loaded page.
- **Instead:** keep the current semantics. If the API later exposes distinct filter facets, a searchable `ManageSelectionModal` can replace free text without reducing query coverage.
- **Existing component:** `ManageSelectionModal` only after an authoritative facet endpoint exists.
- **Effort / impact:** **none now.** No current defect.

#### The compact chat model picker declares a listbox without listbox keyboard behavior

- **Files:** `web/modules/advisor/ModelPicker.tsx:37-59`; `web/modules/advisor/ModelOptionList.tsx:56-98`.
- **Today:** the popup uses `role="listbox"` and rows use `role="option"`, but opening it does not move focus into the list and Arrow Up/Down, Home/End, typeahead, and Escape-to-trigger behavior are not implemented. Keyboard users must Tab through every model row.
- **Instead:** implement the same active-option, roving focus, typeahead, Escape, and focus-return contract already used by the shared single-choice control. Keep the grouped model visuals and one shared `ModelOptionList` data source.
- **Existing component:** `SelectMenu` is the existing keyboard/listbox interaction reference; `BrainModelField` demonstrates the full searchable model-selection flow.
- **Effort / impact:** **medium / high.** Makes a frequently used chat control match the ARIA semantics it already advertises.

#### Mobile diagnostics opens a second fullscreen modal for navigation panels

- **Files:** `web/modules/settings/ConversationDiagnosticsModal.tsx:367-385`, `455-462`.
- **Today:** diagnostics is already a fullscreen modal. On narrow viewports, opening Sessions or Tools creates another `Modal` inside it, adding a second close/back layer merely to navigate the same workspace.
- **Instead:** switch the fullscreen workspace in place between Content, Sessions, and Tools, with a compact `Segmented`/tab control or an internal slide-over region. Preserve the current session selection when returning to Content.
- **Existing component:** `Segmented`; the in-place Messages/Inspector tabs at `ConversationDiagnosticsModal.tsx:420-443` already establish the local pattern.
- **Effort / impact:** **medium / medium.** Removes modal-on-modal navigation and makes phone back/close behavior predictable.

#### Process kill is immediate and failures are silently swallowed

- **Files:** `web/modules/advisor/TelemetryPanel.tsx:193-198`, `320-359`.
- **Today:** the X button kills a background process immediately, including a process owned by another conversation, and `brainKillProcess(id).catch(() => undefined)` hides any failure. The adjacent process row provides no recovery or explanation.
- **Instead:** open a confirmation naming the command and origin, state that the process group is terminated immediately, then show success/failure feedback. Keep a separate, explicit action for processes outside the current conversation.
- **Existing component:** `ConfirmDialog` and `Toast`.
- **Effort / impact:** **small / high.** Protects irreversible runtime work and removes success-shaped failure handling.

#### Skill deletion confirmation does not explain what is lost

- **Files:** `web/modules/advisor/SkillsModal.tsx:37-42`, `97-103`.
- **Today:** the confirmation body contains only `/skill:name`. It does not say that the reusable instruction content is permanently deleted or that bundled/instance skills are protected differently from user-owned skills.
- **Instead:** include the skill scope/owner and explicit irreversible-loss copy in the existing confirmation.
- **Existing component:** `ConfirmDialog` already supports multiline descriptions.
- **Effort / impact:** **small / medium.** Makes the consequence clear at the moment of deletion.

### Plugin manifests and plugin-owned settings

#### Time zone is a hand-typed IANA identifier

- **Files:** `plugins/runtime-context/elowen-plugin.json:8-10`; generic fallback input at `web/modules/settings/PluginConfigEditor.tsx:582-583`.
- **Verification:** **Verified.** A person must know and type values such as `Europe/Prague` exactly.
- **Instead:** add a timezone field type backed by the browser's supported IANA zone list, with search, current-browser-zone suggestion, and an explicit **Server default** option.
- **Existing component:** `ManageSelectionModal` plus `SelectionSummary`; there is no dedicated timezone picker today.
- **Effort / impact:** **medium / high.** Removes a common typo from a value that controls both prompt time and scheduled-job timing.

#### Channel, chat, and thread targets are typed as opaque IDs despite live catalogs

- **Files:** installed `discord/elowen-plugin.json:64-79`, `telegram/elowen-plugin.json:48-57`, and `whatsapp/elowen-plugin.json:38-53`; destination picker at `web/modules/settings/PluginConfigEditor.tsx:48-83`; Discord's live channel provider at installed `discord/index.mjs:22-41`.
- **Verification:** **Verified with narrowed scope.** Notification fields can use the existing destination catalog now. Allowed server/chat/thread scope fields need platform-specific multi-select catalogs; Discord already exposes a channel-list route, while Telegram/WhatsApp may require catalog work. `guildId` is a server-scope restriction, not a notification destination, so it should not be blindly converted to the same field type.
- **Today:** notification destinations and allowed scopes are entered as IDs, phone/JID values, or comma-separated lists; users must leave the UI to discover opaque identifiers.
- **Instead:** declare proactive notification targets as `destination`. Add catalog-backed multi-target fields for allowed threads/chats/groups where a provider can enumerate them, preserving unknown stored IDs. Keep advanced raw entry only where the platform cannot supply a complete catalog.
- **Existing component:** `ManageSelectionModal` and `SelectionSummary`; `DestinationField` already preserves stale values.
- **Effort / impact:** **medium / high.** Replaces brittle copy/paste configuration wherever the platform can authoritatively name the target.

#### TTS voice must remain open to provider-defined values

- **Files:** installed `discord/elowen-plugin.json:280-305`; `telegram/elowen-plugin.json:242-267`; runtime pass-through in installed `discord/lib/adapter.mjs:960` and `telegram/lib/adapter.mjs:837`.
- **Correction:** the original enum recommendation is withdrawn. The plugins pass the string directly to the configured OpenAI-compatible provider and do not validate it against the six examples in the hint. Providers can add voices, so a closed enum would turn an advanced escape hatch into a stale allow-list.
- **Instead:** keep free text. If discoverability is desired, add non-binding suggestions or a `ChoiceField`-plus-Custom pattern rather than rejecting unknown values.
- **Existing component:** `ChoiceField` for suggestions and `Input` for Custom.
- **Effort / impact:** **small / low.** Optional discoverability improvement only; no closed enum recommended.

#### Schedule and active hours require memorising a mini-language

- **Files:** installed `cronjob/web-src/JobsSettings.tsx:235-267`; schedule grammar in `cronjob/elowen-plugin.json:193-195`.
- **Verification:** **Verified.** Schedule and active hours are monospaced text inputs; validity appears only after typing.
- **Instead:** provide a builder for supported human schedules: frequency, day selector for weekly schedules, time input, and an optional active-hours range. Keep an explicit Advanced Cron input for the five-field form and show the generated schedule/next run.
- **Existing component:** `Segmented` for frequency/day choices and `Input type="time"`; no reusable cron-builder component exists today.
- **Effort / impact:** **large / high.** Scheduling becomes approachable without removing the advanced syntax.

#### Codebase and OneDrive configuration encode collections as comma/newline text

- **Files:** installed `codebase/elowen-plugin.json:36-46`, `154-159`; installed `onedrive/elowen-plugin.json:53-57`.
- **Verification:** **Verified.** Include/exclude patterns, repository paths, and additional ignores are delimiter-managed strings.
- **Instead:** use a token/chip editor: Enter or comma creates a validated item, each item has a remove affordance, duplicates are rejected, and multiline paste expands into chips. For repository paths, pair it with the existing directory browser.
- **Existing component:** there is **no editable token-list component** in `web/components/ui` today. `SelectionSummary` is a compact display but not an editor; `DirectoryPicker` handles browseable paths.
- **Effort / impact:** **medium / high.** Makes collection configuration inspectable and reduces malformed patterns.

#### Codebase repository paths are typed although the app already browses server folders

- **Files:** installed `codebase/elowen-plugin.json:154-159`; `web/modules/projects/DirectoryPicker.tsx:10-54`.
- **Verification:** **Verified.** Scheduled re-index repositories are absolute paths in a textarea.
- **Instead:** offer browse-and-add using the same read-only server directory browser, plus chips for selected directories.
- **Existing component:** `DirectoryPicker` and the missing token editor noted above.
- **Effort / impact:** **medium / high.** Prevents wrong-path background jobs and makes indexing scope visible.

#### Plugin-owned pages cannot use the shared Slider through the runtime

- **Files:** `web/lib/pluginUi.tsx:27-83`, `290-327`; existing component at `web/components/ui/Slider.tsx`.
- **Today:** the host imports and publishes many settings primitives through `window.ElowenUiRuntime`, including `Toggle`, `Segmented`, and `ChoiceField`, but not `Slider`. A plugin-owned custom settings page therefore has to approximate the control or fall back to a number input even when the core already has the desired component.
- **Instead:** export `Slider` through the plugin UI kit/runtime contract and use it for genuinely coarse bounded plugin values with an adjacent formatted readout.
- **Existing component:** `Slider`.
- **Effort / impact:** **small / medium.** Removes an artificial consistency gap between core settings and plugin-owned settings pages.

## Cross-cutting inconsistencies

1. **Unit-aware quantity pattern should win:** use `Slider` plus readout for coarse bounded values, presets for policy values, and precise number entry for wide or unbounded ranges. The renderer needs metadata to choose honestly rather than treating every number alike.
2. **Known one-of-many pattern should win:** `ChoiceField` for short sets and `ManageSelectionModal`/`SelectionSummary` for searchable live catalogs. Keep free text when the provider or server owns an open vocabulary.
3. **Known collections should win:** named, removable selections with stale-value preservation. `PluginConfigEditor` already implements this for projects, plugins, tools, models, and destinations; path/glob and allowed-target lists bypass it.
4. **Browseable server paths should win:** use `DirectoryPicker` anywhere an absolute filesystem path is edited. Creation does this; project editing and codebase indexing do not.
5. **Destructive state changes need consequence-specific confirmation:** user role changes, process kills, skill deletion, and project removal should name the target and say what is lost or revoked.
6. **ARIA roles must match interaction behavior:** a component declaring listbox semantics must implement focus entry, arrow navigation, selection keys, Escape, and focus return.
7. **Parent editing state must survive nested decisions:** confirmations should sit above a still-mounted draft, not destroy the draft before the person has confirmed the action.
8. **Plugin surfaces need the same primitives as core surfaces:** the runtime currently exposes most settings controls but omits `Slider` and cannot expose `DirectoryPicker` to plugin pages.

## Areas already following the standard

- Chat's full model overlay uses one shared catalog (`ModelModal` and `ModelOptionList`); only the compact popover's keyboard contract needs work.
- Reasoning levels use `ReasoningScale`, and the thought-row preference uses `Toggle` (`web/modules/advisor/ReasoningModal.tsx`).
- The shared `Modal` traps focus, restores it through the overlay stack, uses `dvh`/safe areas, and prevents nested-backdrop clicks from closing a parent (`web/components/ui/Modal.tsx:39-150`).
- Memory provides explicit loading, error, empty, filtered-empty, confirmation, relative-time, and narrow-column behavior across its register and detail views.
- Project removal, memory purge/empty trash, plugin-data clearing, log deletion, category deletion, task deletion/clearing, and user deletion already have confirmations with consequence copy; the findings above target the remaining gaps or draft-loss behavior.
- Account profile and platform-link autosaves retain edits and revert optimistic model selection on failure (`web/modules/account/AccountView.tsx:140-229`).
- Markdown asset editing retains the drawer/form on save failure and uses explicit loading/error/empty/search-empty states (`web/modules/settings/MarkdownAssetEditor.tsx:142-180`, `231-330`).
- Project creation has a real directory picker; it only needs parity in edit mode.
- Brain/Runtime limits, memory retention, terminal preferences, memory importance, and model/catalog selection make strong use of shared sliders, toggles, segmented controls, and managed selections.
- Cron's model and notification-destination fields already use `BrainModelField` and `ManageSelectionModal`; schedule syntax is the remaining manual part.

## Priority order

1. **Fix destructive-action safety and draft preservation:** confirm admin role changes and process kills, stop swallowing kill errors, clarify skill deletion, and keep the Edit Project draft mounted through removal confirmation.
2. **Fix generic plugin-field accessibility:** connect every schema-rendered input/editor to its manifest label.
3. **Upgrade generic plugin numbers with unit/control metadata:** sliders only for suitable coarse ranges, presets for policy values, and formatted precise inputs everywhere else; expose `Slider` to plugin-owned pages.
4. **Replace typed notification and allowed-target IDs where live catalogs exist:** use `destination` immediately for proactive targets and add catalog-backed multi-selects per platform.
5. **Build the schedule editor** with presets and an Advanced Cron mode.
6. **Add a shared editable token-list control** and use it for codebase globs, repository paths, and OneDrive ignores.
7. **Reuse `DirectoryPicker` in Edit Project** and expose a browse-and-add path flow to the codebase plugin.
8. **Complete keyboard behavior in the compact chat model picker** and replace the mobile diagnostics modal-on-modal navigation with in-place panes.
