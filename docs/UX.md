# Web UI control audit

## Scope and standard

This audit covers the core web modules (Settings, Account, Users, Projects, Memory, Dashboard, and chat overlays), the generic plugin renderer, bundled manifests in `plugins/`, and the installed plugin sources under `/var/www/.config/elowen/plugins-data/sandbox/users/1/workspaces/elowen-plugins-fast-v3/plugins/`.

The standard is simple: a person should select known entities and known finite values, adjust bounded quantities in meaningful units, and manage collections as visible items. Free text remains appropriate for prose, arbitrary identifiers, commands, URLs, glob patterns, and genuinely open-ended model identifiers. Existing `Slider`, `Toggle`, `Segmented`, `ChoiceField`, `SelectMenu`, `BrainModelField`, `ManageSelectionModal`, and `SelectionSummary` establish the house patterns.

## Findings

### Settings — generic plugin configuration

#### Bounded numeric settings are universally rendered as raw number boxes

- **Files:** `web/modules/settings/PluginConfigEditor.tsx:459-464`; manifest examples: `plugins/mcp/elowen-plugin.json:71-90`, `plugins/terminal/elowen-plugin.json:39-69`, `plugins/files/elowen-plugin.json:53-94`, `plugins/subagent/elowen-plugin.json:63-88`; installed `cronjob/elowen-plugin.json:50-150`, `codebase/elowen-plugin.json:49-171`, and channel-plugin media limits.
- **Today:** every manifest field of type `number` becomes an `<Input type="number">`, even where the manifest defines a tight min/max/step. Operators type raw milliseconds, bytes, characters, and counts such as `120000`, `5242880`, and `86400000`.
- **Instead:** when `min`, `max`, and `step` are supplied, render `Slider` with the current formatted value and units, as `RuntimeLimitsModal` and `BrainLimitsModal` already do. Keep the number input only for unbounded or precision-oriented values. Add a unit/display metadata field to the schema rather than making people reason in storage units.
- **Existing component:** `web/components/ui/Slider.tsx`; formatting pattern in `web/modules/settings/RuntimeLimitsModal.tsx:93-131`.
- **Effort / impact:** **medium / high.** One renderer enhancement modernises many plugin settings and makes limits legible and safely bounded.

#### Some number schemas omit the bounds required for a safe direct control

- **Files:** `plugins/web/elowen-plugin.json:49-53`; installed `onedrive/elowen-plugin.json:39-50` and `web/elowen-plugin.json:9-12`.
- **Today:** `maxResults`, OneDrive sync interval, and largest file are raw numeric inputs with no declared min, max, step, or user-facing unit treatment.
- **Instead:** declare validated ranges and steps in the manifests, then inherit the bounded-number renderer above. Display `seconds`, `MB`, and `results`, rather than their implicit storage values.
- **Existing component:** `Slider` after manifest bounds exist.
- **Effort / impact:** **small / medium.** Prevents accidental extreme values and makes routine tuning much faster.

### Settings — Brain, memory, and system

#### Temperature has two incompatible editors

- **Files:** `web/modules/settings/BrainProvidersSection.tsx:301-310`; `web/modules/settings/ProviderCompatibilityModal.tsx:108-134`.
- **Today:** the same `0–2` temperature setting is a typed number input in the normal provider form and a toggle plus `Slider` with a `0.1` readout in the compatibility drawer.
- **Instead:** use the compatibility drawer's toggle-and-slider treatment in both paths, or route the provider form through that editor. This is a bounded scalar where a slider communicates the range better than a text field.
- **Existing component:** `Slider` and `Toggle`.
- **Effort / impact:** **small / medium.** Removes one visibly inconsistent control and avoids invalid-looking decimal entry.

#### Default-token and retention periods are still typed as bare integers

- **Files:** `web/app/settings/page.tsx:640-643`, `web/app/settings/page.tsx:666-681`.
- **Today:** default token TTL and retention days use native number inputs. TTL has neither an explicit unit in the control nor a bounded/preset interaction; retention has a separate `Toggle` and a bare `days` input despite retention modals elsewhere using labelled sliders.
- **Instead:** use a bounded `Slider` with an adjacent formatted duration for TTL, and the same duration slider pattern for retention days. Offer sensible presets where the value is normally policy-driven (for example, 7, 30, 90, 365 days).
- **Existing component:** `Slider`; duration/readout pattern in `MemoryRetentionModal.tsx:80-105`.
- **Effort / impact:** **small / medium.** Makes policy settings understandable without knowing their backend units.

#### Embedding dimensions expose a raw provider detail without guardrails

- **Files:** `web/modules/settings/MemorySection.tsx:177-188`.
- **Today:** dimensions are a text-editable number with a `1536` placeholder and no presets or visible constraints.
- **Instead:** offer a small `Segmented` set of common configured-model dimensions plus a clearly labelled custom numeric option; preserve free entry only when the selected provider supports custom dimensions.
- **Existing component:** `Segmented` (or `ChoiceField` when the provider catalog is longer).
- **Effort / impact:** **medium / medium.** Reduces index-breaking configuration mistakes while retaining advanced use.

### Projects

#### Editing an existing project path loses the picker available on creation

- **Files:** `web/modules/projects/ProjectsView.tsx:391-397` versus `431-433`; `web/modules/projects/DirectoryPicker.tsx:10-54`.
- **Today:** creation pairs the path input with **Browse**, but the Edit Project modal makes a person type the full server path again.
- **Instead:** expose the same `DirectoryPicker` next to the edit path. This is particularly important because the value is an absolute server path, not user prose.
- **Existing component:** `DirectoryPicker`.
- **Effort / impact:** **small / high.** Eliminates a high-friction, error-prone operation with an existing control.

### Chat overlays and diagnostics

#### Task status uses a bespoke native select instead of the shared picker

- **Files:** `web/modules/advisor/TasksModal.tsx:119-129`; `web/components/ui/SelectMenu.tsx:16-145`.
- **Today:** every task row renders a hand-styled browser `<select>` for the three known states.
- **Instead:** use `SelectMenu` for a consistent, keyboard-capable app picker. If horizontal space allows, `Segmented` is also viable for the three states, but `SelectMenu` preserves the compact row layout.
- **Existing component:** `SelectMenu`.
- **Effort / impact:** **small / low.** Cleans up a visible house-style exception.

#### Conversation diagnostics duplicates the select control and asks for known values as text

- **Files:** `web/modules/settings/ConversationDiagnosticsModal.tsx:178-183`, `231-242`.
- **Today:** the modal has a local `Select` implementation for surface and status, while provider and model filters are free-text fields even though the current diagnostic data can supply their values.
- **Instead:** replace local selects with `SelectMenu`. Populate provider/model filters as searchable selections sourced from loaded sessions, retaining a text search only when a historical arbitrary value must be queried.
- **Existing component:** `SelectMenu`; `ManageSelectionModal` provides the app's searchable-picker pattern if the distinct values are numerous.
- **Effort / impact:** **medium / medium.** Reduces typo-only empty states in an already technical screen and removes duplicate control chrome.

### Plugin manifests and plugin-owned settings

#### Time zone is a hand-typed IANA identifier

- **Files:** `plugins/runtime-context/elowen-plugin.json:8-10`; generic fallback input at `web/modules/settings/PluginConfigEditor.tsx:582-583`.
- **Today:** a person must know and type `Europe/Prague` exactly.
- **Instead:** add a timezone field type backed by the browser's IANA zone list, with search, current-browser-zone as a suggested default, and an explicit `Server default` option.
- **Existing component:** `ManageSelectionModal` plus `SelectionSummary` can provide the searchable selection flow; there is no existing timezone catalog or dedicated picker.
- **Effort / impact:** **medium / high.** Removes a common configuration typo from a value that changes both prompt context and scheduled-job timing.

#### Channel, chat, and thread targets are typed as opaque IDs despite a live destination picker

- **Files:** installed `discord/elowen-plugin.json:64-79`, `telegram/elowen-plugin.json:48-57`, and `whatsapp/elowen-plugin.json:38-53`; generic picker implementation at `web/modules/settings/PluginConfigEditor.tsx:48-83`; cron's equivalent at `cronjob/web-src/JobsSettings.tsx:11-53`.
- **Today:** notification destinations and allowed scopes are entered as Discord IDs, Telegram IDs, phone/JID values, or comma-separated thread/chat lists. The user must leave the UI to discover opaque identifiers.
- **Instead:** declare notification targets as `destination`, which already opens a grouped picker across connected platforms. Add a catalog-backed multi-target field for allowed threads/chats/groups so selections appear as named removable items; preserve unknown saved IDs as the existing selection controls do.
- **Existing component:** `ManageSelectionModal` and `SelectionSummary`; `PluginConfigEditor` already has the stale-value preservation and single-destination implementation.
- **Effort / impact:** **medium / high.** Replaces brittle copy/paste configuration with direct selection of the place the bot will actually use.

#### Known text-to-speech voices are free text in two channel plugins

- **Files:** installed `discord/elowen-plugin.json:280-305`; `telegram/elowen-plugin.json:242-267`.
- **Today:** `ttsVoice` is a string although the hint enumerates exactly six supported values: `alloy`, `echo`, `fable`, `onyx`, `nova`, and `shimmer`.
- **Instead:** make it an `enum`; use the same manifest option list in both plugins so the controls cannot drift. The model IDs can remain free text because providers may expose additional models.
- **Existing component:** `ChoiceField` via the generic enum renderer.
- **Effort / impact:** **small / medium.** Eliminates a silently mistyped voice setting and makes the capability discoverable.

#### Schedule and active hours require memorising a mini-language

- **Files:** installed `cronjob/web-src/JobsSettings.tsx:242-254`; schedule grammar documented in `cronjob/elowen-plugin.json:193-195`.
- **Today:** schedule and active-hours fields are raw monospaced text; validity is only indicated after typing. The user must remember forms such as `daily 06:00`, `weekly sun 20:00`, and `5-21`.
- **Instead:** provide a simple builder for the supported human schedules: frequency `Segmented`, day selector when weekly, time input, and an optional active-hours range. Keep an explicit advanced Cron input for the five-field form and show the generated expression/next run.
- **Existing component:** `Segmented` for frequency/day choices and `Input type="time"` for time; no reusable cron-builder component exists today.
- **Effort / impact:** **large / high.** Scheduling becomes approachable without weakening the advanced cron escape hatch.

#### Codebase and OneDrive configuration encode collections as comma/newline text

- **Files:** installed `codebase/elowen-plugin.json:36-46`, `154-159`; installed `onedrive/elowen-plugin.json:53-57`.
- **Today:** include globs, exclude globs/directories, repository paths, and extra ignore patterns are typed in multiline or comma-separated boxes. Delimiters, duplicate entries, and individual removals are all manual.
- **Instead:** use a token/chip editor: Enter or comma creates a validated item, each item has a remove affordance, duplicates are rejected, and multiline paste expands into chips. For repository paths, pair it with the existing directory browser where the server can browse.
- **Existing component:** there is **no editable token-list component** in `web/components/ui` today. `SelectionSummary` is the right compact selected-state display but not an editor; this is a genuine shared-component gap. Reuse `DirectoryPicker` for browseable repository paths.
- **Effort / impact:** **medium / high.** Makes collection configuration inspectable and substantially reduces malformed patterns.

#### Codebase repository paths are typed although the app already browses server folders

- **Files:** installed `codebase/elowen-plugin.json:154-159`; `web/modules/projects/DirectoryPicker.tsx:10-54`.
- **Today:** scheduled re-index repositories are absolute paths typed into the collection textarea.
- **Instead:** offer a browse-and-add action using the same read-only server directory browser as project creation, plus chips for the selected directories.
- **Existing component:** `DirectoryPicker` (currently not exposed from the plugin UI runtime) and the missing token editor noted above.
- **Effort / impact:** **medium / high.** Prevents wrong-path background jobs and makes the scope visible.

## Cross-cutting inconsistencies

1. **Bounded quantity pattern should win:** `Slider` + formatted unit/readout for bounded operational values. Core Runtime, Brain Limits, retention, and Terminal already demonstrate this; generic plugin configuration, provider temperature, and system policies do not.
2. **Known one-of-many pattern should win:** `ChoiceField` for short sets and `ManageSelectionModal`/`SelectionSummary` for searchable or live catalogs. Do not render raw strings for time zones, known TTS voices, or connected destinations.
3. **Known collections should win:** named, removable selections with stale-value preservation. `PluginConfigEditor` already implements this for projects, plugins, tools, models, and destinations; channel IDs and path/glob lists bypass it.
4. **Browseable server paths should win:** use `DirectoryPicker` anywhere an absolute filesystem path is edited. Creation does this; project editing and codebase indexing do not.
5. **Shared controls should win over local HTML:** `TasksModal` and `ConversationDiagnosticsModal` should not retain bespoke/native select implementations while `SelectMenu` is available.

## Areas already following the standard

- Chat model selection uses a dedicated searchable catalog (`web/modules/advisor/ModelModal.tsx` and `ModelOptionList`).
- Reasoning levels use `ReasoningScale`, and the boolean thought-row preference uses `Toggle` (`web/modules/advisor/ReasoningModal.tsx`).
- Project creation has a real directory picker; it only needs parity in edit mode.
- Brain/Runtime limits, memory retention, terminal preferences, memory importance, and model/catalog selection make strong use of shared sliders, toggles, segmented controls, and managed selections.
- Cron's model and notification-destination fields already use `BrainModelField` and `ManageSelectionModal`; schedule syntax is the remaining manual part.

## Priority order

1. **Upgrade generic plugin numbers** to formatted bounded sliders, then add missing ranges to loose schemas. This improves the largest number of settings in one coherent change.
2. **Replace typed channel/chat/thread targets** with destination and catalog-backed multi-select pickers across Discord, Telegram, and WhatsApp.
3. **Build the schedule editor** with presets and an advanced Cron mode; it removes the most intimidating configuration mini-language.
4. **Add a shared editable token-list control** and use it for codebase globs, repository paths, and OneDrive ignores.
5. **Reuse `DirectoryPicker` in Edit Project** and replace the two local/native select implementations with `SelectMenu`.
