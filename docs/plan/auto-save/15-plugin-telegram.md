# Telegram auto-save audit

## Scope

Audited the registry plugin at `/var/www/elowen-plugins/plugins/telegram` and the host surfaces that render and persist its configuration. The plugin has no `web` block, account panel, user panel, project panel, or custom drawer: its only browser configuration surface is the host's schema-driven `Settings → Plugins → Telegram` detail workspace. The plugin itself registers the Telegram adapter and tools only (`/var/www/elowen-plugins/plugins/telegram/index.mjs:23-34`).

The manifest declares one instance-wide `configSchema` with connection, reply/presentation, conversation, media, voice, and role-policy fields (`/var/www/elowen-plugins/plugins/telegram/elowen-plugin.json:33-280`). There is no `userConfigSchema`, so there is no per-account Telegram settings form or `/user-config` persistence API.

## Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Plugin list and Telegram lifecycle controls: Installed row, Available/install, update, enable/disable, remove/uninstall, restore, and consent/confirmation dialogs | `/var/www/elowen/web/modules/settings/PluginsSection.tsx:194-271,274-315,366-414`; `/var/www/elowen/web/lib/mutations.ts:130-187`; `/var/www/elowen/web/lib/elowenClient.ts:126-166`; `/var/www/elowen/src/api/routes/plugins/index.ts:260-267,324-355,545-578` | Immediate mutations, not draft fields. Enable/install hot-reload the registry; removal/uninstall and install have explicit action/consent flows. | Explicit-save justified |
| Setup drawer/workspace: status, setup checklist, `botToken` secret, `allowedChatIds` token list, and `notifyChatId` string | `/var/www/elowen-plugins/plugins/telegram/elowen-plugin.json:33-58`; `/var/www/elowen/web/modules/settings/PluginDetail.tsx:114-135`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:632-636,660-742,918-1005` | Shared `usePluginConfigDraft` seeds once, debounces 900 ms, serializes full-snapshot PATCHes, flushes on teardown, and exposes saving/saved/error+retry status (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:43-112`; `/var/www/elowen/web/lib/useAutoSaveStatus.ts:26-105`; `/var/www/elowen/web/modules/settings/PluginDetail.tsx:102-111`). The secret is write-only and absent from returned config; empty/absent secret values preserve the stored token (`/var/www/elowen/src/api/routes/plugins/index.ts:62-105,500-518`). | Partial |
| Behavior fields: `respondWithoutMention`, `toolActivity`, `answerMode`, `toolOutput`, `toolMessageMode`, `deleteToolActivityAfterTurn`, `reactions`, `runtimeFooter`, `showReasoning`, and `language` | `/var/www/elowen-plugins/plugins/telegram/elowen-plugin.json:60-157`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:660-759,918-946` | Boolean toggles and enum selectors write through the same 900 ms full-snapshot autosave and visible workspace status. Successful saves invalidate plugin detail/list/command queries (`/var/www/elowen/web/lib/mutations.ts:283-288`). | Partial |
| Conversation and voice fields: `visionModel`, `voiceProvider`, `stt`, `sttModel`, `tts`, `ttsModel`, and `ttsVoice` | `/var/www/elowen-plugins/plugins/telegram/elowen-plugin.json:159-168,222-268`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:712-740` | Shared brain model picker and provider picker update the draft; strings and toggles update inline. The same debounced PATCH persists all fields atomically at the host config layer (`/var/www/elowen/src/api/routes/plugins/index.ts:500-518`; `/var/www/elowen/src/store/configStore.ts:1211-1216`). | Partial |
| Role policies modal: add/expand/edit role, `roleId`, name, admin toggle, prompt, and remove-role confirmation | `/var/www/elowen-plugins/plugins/telegram/elowen-plugin.json:270-280`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:337-425,764-819` | Edits and additions use the shared debounced autosave. Removal is intentionally confirmed and committed immediately with `draft.commitValue`, flushing any older pending snapshot first (`/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:353-362,413-422`; `/var/www/elowen/web/lib/usePluginConfigDraft.ts:83-101`). | Partial |
| Advanced media drawer/workspace: `maxImageBytes`, `maxImages`, `maxUploadImages`, and `askTimeoutMs` number inputs | `/var/www/elowen-plugins/plugins/telegram/elowen-plugin.json:170-220`; `/var/www/elowen/web/modules/settings/PluginDetail.tsx:85-90`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:924-946,980-1005` | Number inputs use the same debounced autosave; server validation enforces finite values, bounds, and step alignment before persistence (`/var/www/elowen/src/api/routes/plugins/index.ts:20-41,500-518`). | Partial |
| Capabilities, activity/logs, and advanced data panels | `/var/www/elowen/web/modules/settings/PluginDetail.tsx:141-153`; `/var/www/elowen/web/modules/settings/PluginDataPanel.tsx:24-55,60-67` | Read-only capability/activity views have no editable fields. Data clear is a destructive, confirmed immediate POST (`/var/www/elowen/web/lib/elowenClient.ts:142-143`; `/var/www/elowen/src/api/routes/plugins/index.ts:485-497`). | N/A |
| Telegram chat-local controls: `/new`, `/model`, `/reasoning`, `/voice`, `/display`, and inline model/reasoning/display callbacks | `/var/www/elowen/packages/plugin-shared/chatCommands.mjs:80-88`; `/var/www/elowen-plugins/plugins/telegram/lib/adapter.mjs:563-677` | Not a web form. Commands and callbacks mutate per-chat state immediately through `StateStore.patch`. The shared store uses atomic JSON replacement, updates its cache only after a successful write, and rethrows failures (`/var/www/elowen/packages/plugin-shared/stateStore.mjs:3-31`). | N/A |

## Missing or inconsistent auto-save

- **Activation-pending feedback is inconsistent for ordinary autosaves.** The plugin config API deliberately returns HTTP 202 with `{ pending: true }` when the durable config write succeeds but live registry activation is deferred (`/var/www/elowen/src/api/routes/plugins/index.ts:116-137,500-518`; `/var/www/elowen/web/lib/elowenClient.ts:134-135`). The regular autosave callback awaits `queueSave(...)` but discards its response (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:72-80`), so the toolbar reports only “Saved”. Role-policy deletion is the exception: `commitValue` returns `pending`, and the role editor displays activation-pending feedback (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:99-101`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:351-368`). Durable persistence is correct, but the user-facing state does not consistently distinguish “saved” from “saved, activation pending”.

- **`rolePolicies` lacks schema validation at the persistence boundary.** The server-side shared patch validator checks number, timezone, and token-list fields, but has no branch for `rolePolicies` (`/var/www/elowen/src/api/routes/plugins/index.ts:67-85`). The UI can add and autosave an empty `{ roleId: '', name: '', prompt: '' }` row (`/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:346-354`). Runtime matching tolerates malformed entries and simply searches the first matching policy (`/var/www/elowen-plugins/plugins/telegram/lib/ids.mjs:34-47`), so malformed or duplicate policies can persist without a visible field error. This is a permission-sensitive persistence gap, not an autosave transport failure.

- **No Telegram-specific browser coverage proves the real manifest is fully reachable in the intended tabs.** Host tests prove generic field autosave, drawers, role deletion, secret handling, and stale-draft behavior, but use synthetic schemas (`/var/www/elowen/web/tests/modules/settings/PluginDetail.test.tsx:199-205,383-449`; `/var/www/elowen/web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105`). Registry tests cover Telegram manifest/runtime behavior and token-list compatibility, not the host editor (`/var/www/elowen-plugins/tests/telegram.test.ts:12-24,109-133,185-201`).

## Legitimate exceptions

- `botToken` is a credential. The host masks it, never returns its value, offers an explicit replace action, and preserves it when an autosave omits or sends an empty secret (`/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:869-899`; `/var/www/elowen/src/api/routes/plugins/index.ts:62-85,89-105`).
- Removing a role policy changes admission and administrator permissions. Confirmation plus an immediate, serialized commit is justified; it prevents a destructive permission change from being left only in a local draft (`/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:353-362,413-422`).
- Plugin enable/install/uninstall/remove/restore and plugin-data clear are operational or destructive actions, not ordinary editable preferences. Immediate mutation with consent/confirmation is appropriate (`/var/www/elowen/web/modules/settings/PluginsSection.tsx:274-315,405-414`; `/var/www/elowen/web/modules/settings/PluginDataPanel.tsx:24-55`).
- Telegram per-chat commands are inherently immediate controls rather than web settings. Atomic `StateStore` persistence is the appropriate mechanism for `/model`, `/reasoning`, `/display`, `/voice`, and `/new`.

## Reusable existing pattern

Use the host pattern already applied to this plugin:

- `usePluginConfigDraft` owns one draft, one debounced autosave, serialized full snapshots, JSON validation, stale-refresh isolation, teardown flush, and retry (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-112`).
- `useAutoSaveStatus` provides bounded debounce, queued latest-state writes, visible terminal status, flush, and retry (`/var/www/elowen/web/lib/useAutoSaveStatus.ts:6-30,45-105`).
- `AutoSaveStatus` renders saving/saved/error+retry accessibly (`/var/www/elowen/web/components/ui/AutoSaveStatus.tsx:7-26`), and `PluginDetail` places it in the persistent workspace toolbar (`/var/www/elowen/web/modules/settings/PluginDetail.tsx:102-111`).
- The shared API applies a schema-aware patch before persistence, preserves write-only secrets, and persists before attempting live reload (`/var/www/elowen/src/api/routes/plugins/index.ts:62-86,500-518`). `ConfigStore` merges only the addressed plugin slice and writes the SQLite settings row atomically (`/var/www/elowen/src/store/configStore.ts:1021-1024,1211-1216`).

## Tests and gaps

Existing evidence:

- Generic host autosave tests cover direct fields, scaled numbers, sliders, timezone pickers, token lists, document editors, and save payloads (`/var/www/elowen/web/tests/modules/settings/PluginDetail.test.tsx:199-369,383-410`).
- Generic draft tests cover invalid JSON, write-only secrets, immediate commit failure/success, and serialized stale-snapshot protection (`/var/www/elowen/web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105`).
- Host API tests cover masked secrets, defaults, atomic validation, persistence-before-reload, deferred 202 responses, reload failures, and pre-persistence failures (`/var/www/elowen/tests/api/pluginRoutes.test.ts:103-210,339-381`).
- Telegram registry tests cover token-list compatibility, plugin registration, identity policies, and runtime command/picker behavior (`/var/www/elowen-plugins/tests/telegram.test.ts:12-24,109-133,185-201,215-365`).
- Atomic per-chat persistence is tested for successful writes, corruption handling, failed writes, and recovery (`/var/www/elowen/tests/plugins/sharedStateStore.test.ts:13-69`).

Gaps:

- No test exercises a real Telegram `configSchema` through `PluginDetail` and verifies every declared field's tab, control, autosave payload, and reload persistence.
- No test verifies ordinary Telegram config autosave behavior when the API returns 202; only the immediate `commitValue` path exposes pending activation today.
- No API/UI regression test rejects malformed Telegram role policies, blank newly-added rows, duplicate IDs, or a wildcard policy placed before named policies.
- No test explicitly proves the Telegram secret is preserved through a full autosave snapshot after editing a non-secret field against the actual Telegram manifest.

## Recommended migration notes

- Keep Telegram on the shared schema-driven editor and `PATCH /plugins/:name/config`; do not add a plugin-specific web form or persistence path.
- Extend the shared draft/status contract so normal autosaves retain the API response and expose a distinct durable-save/activation-pending state. Apply the same treatment to role-policy deletion instead of maintaining a one-off pending indicator.
- Add authoritative `rolePolicies` validation at the shared plugin config route, with matching UI validation: reject blank/invalid IDs, enforce trimmed unique entries, and either enforce wildcard-last or clearly normalize/document that ordering. Prevent an empty newly-added row from being persisted as a usable policy.
- Add a focused Telegram host integration test covering the manifest's Setup, Behavior, and Advanced grouping, all toggles/selectors/pickers, secret preservation, and a deferred activation response.
- Preserve the existing immediate semantics for plugin lifecycle operations, destructive data clear, and Telegram chat-local commands; these are legitimate non-autosave actions rather than migration targets.
