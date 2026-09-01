# Scope

Audit covers registry plugin `voice-bot` at `/var/www/elowen-plugins/plugins/voice-bot`, its manifest-declared configuration, every host web/settings/drawer surface exposed by that manifest, and the persistence paths that affect those surfaces. The plugin declares one tool, five instance-wide config fields, `userGrantable: true`, database access, and network access (`elowen-plugin.json:1-26`). It declares neither `web` nor `userConfigSchema`; there is no plugin-owned browser bundle, page, account section, or drawer (`elowen-plugin.json:1-79`; `/var/www/elowen-plugins/plugins/voice-bot` contains only `elowen-plugin.json`, `index.mjs`, `lib/`, `i18n/`, and `icon.svg`).

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Settings → Plugins installed-list enable toggle | `/var/www/elowen/web/modules/settings/PluginsSection.tsx:81-140,194-212`; `/var/www/elowen/web/modules/settings/usePluginConsent.tsx:24-31,71-109`; `/var/www/elowen/web/lib/mutations.ts:130-159` | Immediate `PATCH /plugins/voice-bot` mutation. Enablement can open a consent dialog because `userGrantable`/capability grants are authority changes; optimistic state rolls back on error and refetches on settle. | Explicit-save justified |
| Plugin detail hero enable toggle | `/var/www/elowen/web/modules/settings/PluginSummary.tsx:8-25`; `/var/www/elowen/web/modules/settings/PluginActions.tsx:9-30` | Same immediate enable/disable mutation and shared consent flow as the installed list. This is an operational permission/activation action, not ordinary editable configuration. | Explicit-save justified |
| Plugin detail → Setup → Connection card (`apiUrl`, `apiToken`) | `/var/www/elowen-plugins/plugins/voice-bot/elowen-plugin.json:26-47`; `/var/www/elowen/web/modules/settings/PluginDetail.tsx:58-65,102-140`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:632-636,710-711,835-915,922-1005` | Shared draft autosaves the complete config snapshot after 900 ms through `PATCH /plugins/voice-bot/config`. `apiToken` is write-only: existing values are masked and replacement is exposed only after an explicit Replace action. The server keeps empty/absent secrets and never returns their value (`src/api/routes/plugins/index.ts:89-105,500-517`). | Partial |
| Plugin detail → Behavior → Limits card (`maxCallsPerHour`, `callTimeoutSeconds`, `defaultInitMessage`) | `/var/www/elowen-plugins/plugins/voice-bot/elowen-plugin.json:49-78`; `/var/www/elowen/web/modules/settings/PluginDetail.tsx:134-140`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:663-708,918-1015` | Boolean/number/text controls update the shared draft on every edit; the draft serializes full-snapshot saves with a 900 ms debounce. Number bounds and steps are enforced by the config route before persistence; successful persistence triggers live plugin reload. | Compliant |
| Plugin detail shared save status / retry | `/var/www/elowen/web/modules/settings/PluginDetail.tsx:102-112`; `/var/www/elowen/web/components/ui/AutoSaveStatus.tsx:7-27`; `/var/www/elowen/web/lib/usePluginConfigDraft.ts:72-112` | Visible `Saving`, `Saved`, and `save failed` + Retry states. Pending live activation is returned separately and shown by the shared plugin-config feedback. The draft flushes on unmount and serializes writes to prevent stale responses from rolling back newer edits. | Compliant |
| Users → user detail → Granted plugins selector | `/var/www/elowen/web/modules/users/UserDetailPane.tsx:198-253`; `/var/www/elowen/web/lib/elowenClient.ts:342-345`; `/var/www/elowen/src/api/routes/auth.ts:461-468` | `voice-bot` appears because the manifest sets `userGrantable: true` (`elowen-plugin.json:7-8`). The multi-select is edited in a modal and persisted only by its explicit Save action via `PATCH /users/:id`; the server clamps names to manifest-declared grantable plugins. | Explicit-save justified |
| Plugin-owned web page, settings section, account drawer, or user drawer | `/var/www/elowen-plugins/plugins/voice-bot/elowen-plugin.json:1-79`; `/var/www/elowen-plugins/registry.json:209-218` | No `web` declaration, no `web-src`, no `userConfigSchema`, and no plugin-owned route or drawer. Host plugin page/account loaders therefore have nothing to mount. | N/A |
| `VoiceCall` runtime operation and call-history persistence | `/var/www/elowen-plugins/plugins/voice-bot/index.mjs:13-22`; `/var/www/elowen-plugins/plugins/voice-bot/lib/tool.mjs:51-183`; `/var/www/elowen-plugins/plugins/voice-bot/lib/store.mjs:13-89` | Not an edit form. Each accepted call is recorded before the external POST, then settled with status/HTTP response/transcript; the SQLite record also supplies the hourly rate-limit window and is removed on account teardown. | N/A |

# Missing or inconsistent auto-save

- The ordinary config path is correctly autosaved, but required-field validation is incomplete. `usePluginConfigDraft` always calls `useAutoSaveStatus` with its default `savable: true` and only validates JSON (`web/lib/usePluginConfigDraft.ts:72-80`; `web/lib/useAutoSaveStatus.ts:19-24,26-83`). The Setup checklist computes missing required fields for navigation/status, but does not prevent an invalid edit from being sent (`web/modules/settings/PluginDetail.tsx:58-65,116-134`).
- For `voice-bot`, `apiUrl` is a required string but the host route does not validate URL shape or non-empty required values; `apiToken` is required but accepts arbitrary replacement text and is intentionally not clearable through an empty value. The plugin only decides after reload whether both values are usable and otherwise omits `VoiceCall` (`lib/tool.mjs:51-62`). This makes persistence reliable, but the saved/error state can represent a durable configuration that cannot activate the tool.
- The connection card is therefore `Partial`, not `Missing`: edits are durable, debounced, serialized, visibly reported, and protected against stale refetches, but semantic required-field validation is absent.
- There is no stale-draft overwrite found in the shared path: refetches do not re-seed the draft after initial mount (`usePluginConfigDraft.ts:37-63`), and queued full snapshots are serialized (`usePluginConfigDraft.ts:52-70`).
- No plugin-specific save-status, retry, drawer-close, or navigation gap exists because the plugin owns no custom web surface.

# Legitimate exceptions

- `apiToken` is a credential and is correctly handled as write-only. Masking the stored value, requiring an explicit Replace action, preserving an empty/absent secret, and never returning it are justified security constraints (`elowen-plugin.json:42-46`; `src/api/routes/plugins/index.ts:89-105,500-517`; `web/tests/modules/settings/PluginDetail.test.tsx:430-449`).
- Enabling/disabling the plugin is an immediate explicit mutation rather than debounce-based autosave because it changes live tool availability and can require grant consent (`PluginActions.tsx:9-30`; `usePluginConsent.tsx:24-31,65-109`).
- Per-user plugin grants use an explicit modal Save because they change another user's authority boundary, not a preference field (`UserDetailPane.tsx:198-253`; `auth.ts:461-468`).
- Calling a real telephone number is an irreversible external action and is intentionally not an autosave candidate. The tool description explicitly states that calls cannot be cancelled or undone (`lib/tool.mjs:64-82`).

# Reusable existing pattern

Use the host's `usePluginConfigDraft` + `useAutoSaveStatus` path as the canonical pattern. It provides a 900 ms bounded debounce, seed protection, serialized full-snapshot writes, unmount flush, visible status/error/retry, and pending activation handling (`web/lib/usePluginConfigDraft.ts:37-112`; `web/lib/useAutoSaveStatus.ts:6-17,45-105`). The config editor already renders manifest sections as shared `SettingsGroup` cards and fields as shared `SettingsRow` controls (`web/modules/settings/PluginConfigEditor.tsx:632-636,961-1015`).

# Tests and gaps

- Plugin tests cover manifest/catalog agreement and prove all `ctx.config` reads have declared fields (`/var/www/elowen-plugins/tests/voiceBot.test.mjs:332-353`).
- Runtime tests cover endpoint/token gating, E.164 and prompt validation, configured timeout/limit behavior, secret redaction, call recording, and account teardown (`tests/voiceBot.test.mjs:88-116,162-189,223-262,304-329`).
- Host draft tests cover invalid JSON, write-only secrets, immediate commit failure, pending activation, and stale full-snapshot ordering (`/var/www/elowen/web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105`).
- Host route tests cover config patch merging, secret preservation, type/range validation, persistence-before-reload, deferred activation, and write failure (`/var/www/elowen/tests/api/pluginRoutes.test.ts:128-176,339-379`).
- Gap: there is no voice-bot-specific web test exercising the real manifest through `PluginDetail` and asserting that all five fields autosave, that a malformed/empty required `apiUrl` is surfaced before or during save, or that replacing `apiToken` reaches the write-only path.
- Gap: no route-level validation test exists for required string/secret fields or URL syntax; current server validation is strong for numeric fields but intentionally generic for strings (`src/api/routes/plugins/index.ts:20-41,62-86`).

# Recommended migration notes

- Keep the current shared autosave architecture; do not add a plugin-local form or drawer.
- Decide whether required plugin fields should remain checklist-only globally or become a shared `savable` predicate. For `voice-bot`, the safer behavior is to block or visibly reject empty `apiUrl` and missing replacement token while preserving the write-only secret contract.
- Add a focused host/plugin integration test for the manifest's five fields and connection-card failure behavior. Keep the existing runtime fallback that omits `VoiceCall` when endpoint/token are unavailable.
- Preserve explicit Save for user grants and explicit Replace for the API token; neither should be converted into ordinary field autosave without retaining their authority/security semantics.
