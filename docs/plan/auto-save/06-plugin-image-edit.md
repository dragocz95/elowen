# Scope

Audited registry plugin `image-edit` at `/var/www/elowen-plugins/plugins/image-edit` and the host surfaces that render and persist its configuration. The plugin has no custom web bundle, settings metadata, account panel, user panel, project panel, or plugin-owned drawer: `elowen-plugin.json` ends after the instance `configSchema` at `elowen-plugin.json:17-32`. Its only declared surface is the `EditImage` tool (`elowen-plugin.json:12-15`). The effective UI is therefore the host's generic Settings → Plugins workspace.

The audit covers the provider/model controls, enablement lifecycle, read-only detail panels, generated-image data lifecycle, configuration routes, validation, loading/error feedback, and focused tests.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Installed plugin row: enable/disable toggle | `/var/www/elowen/web/modules/settings/PluginsSection.tsx:81-141,271-277`; `/var/www/elowen/web/modules/settings/usePluginConsent.tsx:71-79`; `/var/www/elowen/web/lib/mutations.ts:130-159` | Immediate `PATCH /plugins/:name` mutation; optimistic list/detail update, rollback on error, settled refetch, and toast. This is an operational lifecycle action, not a draft form. | Explicit-save justified |
| Plugin hero toggle and status | `/var/www/elowen/web/modules/settings/PluginSummary.tsx:8-25`; `/var/www/elowen/web/modules/settings/PluginActions.tsx:9-31` | Same immediate enable/disable mutation and consent flow; busy state disables the toggle and deferred activation is reported by toast. | Explicit-save justified |
| Setup → Provider | `/var/www/elowen/web/modules/settings/PluginDetail.tsx:58-65,114-135`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:530-540,718-720`; `/var/www/elowen-plugins/plugins/image-edit/elowen-plugin.json:17-25` | Generic `provider` picker filtered to configured, key-set OpenAI providers. Every change enters the shared draft and is persisted after a 900 ms debounce through `PATCH /plugins/:name/config`. No explicit Save button. | Partial |
| Behavior → Model | `/var/www/elowen/web/modules/settings/PluginDetail.tsx:138-140`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:713-715`; `/var/www/elowen-plugins/plugins/image-edit/elowen-plugin.json:27-30` | Generic brain-model picker, persisted by the same debounced full-snapshot autosave. The runtime falls back to `gpt-image-1` when unset (`index.mjs:14-20`), but the manifest does not declare `default`. | Partial |
| Capabilities → Tools / Permissions | `/var/www/elowen/web/modules/settings/PluginDetail.tsx:141-147`; `/var/www/elowen/web/modules/settings/PluginToolsPanel.tsx:60-67`; `/var/www/elowen/web/modules/settings/PluginPermissionsPanel.tsx:24-57` | Read-only runtime contribution and manifest-derived risk/capability display. No persistence control. | N/A |
| Activity → Logs | `/var/www/elowen/web/modules/settings/PluginDetail.tsx:148`; `/var/www/elowen/web/modules/settings/PluginLogsPanel.tsx:16-37`; `/var/www/elowen/web/lib/queries.ts:262-266` | Read-only log tail, polled every three seconds while the detail is open. | N/A |
| Advanced → Data / Clear generated images | `/var/www/elowen/web/modules/settings/PluginDetail.tsx:149-153`; `/var/www/elowen/web/modules/settings/PluginDataPanel.tsx:24-55`; `/var/www/elowen/web/lib/mutations.ts:290-296` | Read-only footprint plus destructive `POST /plugins/:name/data/clear` behind confirmation. Clearing generated artifacts must remain explicit and is not an autosave concern. | Explicit-save justified |
| `EditImage` execution and generated PNG persistence | `/var/www/elowen-plugins/plugins/image-edit/index.mjs:37-52,59-100`; `/var/www/elowen/src/plugins/registry.ts:1352-1357`; `/var/www/elowen/src/api/routes/brain.ts:238-250` | Explicit tool invocation fetches a source, calls the external Images API, writes a new PNG under the plugin data directory, and returns an inline chat URL. The original source is not overwritten. | Explicit-save justified |
| Custom web/config/drawer surfaces | `/var/www/elowen-plugins/plugins/image-edit/elowen-plugin.json:1-32` | No `web` declaration and no `web-src` surface; no plugin-specific drawer or account/user/project settings form exists. | N/A |

# Missing or inconsistent auto-save

- **Deferred activation is reported as plain “Saved” for normal fields.** The daemon deliberately returns HTTP 202 with `{ ok: true, pending: true }` when persistence succeeded but plugin reload is delayed (`/var/www/elowen/src/api/routes/plugins/index.ts:116-137,500-518`). The client exposes that contract (`/var/www/elowen/web/lib/elowenClient.ts:133-135`), but the generic autosave callback only awaits the response and discards it (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:72-80`). The detail toolbar renders only the generic status (`/var/www/elowen/web/modules/settings/PluginDetail.tsx:102-111`). Provider/model edits can therefore be durable while the live `image-edit` registration is still one generation behind, with no activation-pending indication. This is the main inconsistency for this plugin.

- **The model default is documented but not declared as configuration data.** The manifest hint says “Default: gpt-image-1” but omits `"default": "gpt-image-1"` (`elowen-plugin.json:27-30`). The host only pre-fills declared defaults (`/var/www/elowen/src/api/routes/plugins/index.ts:89-105`), and the model picker explicitly disallows a default option (`/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:713-715`). Runtime behavior is still correct because `resolveModel()` falls back to `gpt-image-1` (`index.mjs:14-20`), but the UI does not represent the effective value consistently.

- **Required provider is primarily a UI invariant, not a write-path invariant.** The provider is marked `required` in the manifest (`elowen-plugin.json:19-24`) and the setup checklist computes missing required fields (`/var/www/elowen/web/modules/settings/PluginDetail.tsx:59-64`). The shared route patcher validates number/timezone/token-list types but does not enforce `required` (`/var/www/elowen/src/api/routes/plugins/index.ts:62-86,500-518`). A direct API caller can persist an empty provider; the plugin then logs that no provider is configured and registers no tool (`index.mjs:29-35`). The picker normally prevents this because it exposes only configured providers and has no empty option (`/var/www/elowen/web/components/ui/ProviderPicker.tsx:10-23`), but the server boundary is weaker than the declared contract.

- **Network capability is not declared.** `EditImage` sends source bytes and a bearer-authenticated request to the configured external Images endpoint (`index.mjs:67-88`), while the manifest has no `capabilities.network` declaration (`elowen-plugin.json:1-32`). The permissions panel displays declared capabilities only and hides the capability block when none are declared (`/var/www/elowen/web/modules/settings/PluginPermissionsPanel.tsx:39-57`). This does not break autosave, but it makes the permission/risk surface under-report the plugin's real network behavior.

- **No plugin-specific web or drawer autosave path exists.** This is not a missing implementation: the plugin intentionally delegates configuration to the host schema-driven editor. Adding a second plugin-owned form would create a duplicate persistence path and should be avoided.

# Legitimate exceptions

- Enable/disable is an immediate operational action that changes the loaded plugin set and can require consent or deferred hot reload. The existing toggle mutation, rollback, and pending toast are appropriate; an editable draft plus Save button would be worse here.
- Clearing the plugin data directory deletes generated images and is destructive. The confirmation dialog and explicit mutation are justified (`PluginDataPanel.tsx:31-55`).
- `EditImage` itself is an explicit, potentially slow external operation with a two-minute timeout (`index.mjs:9,47-51,70,84-89`). Its output is intentionally persisted as a new artifact, not an automatically saved settings draft.
- No secret is entered in the image-edit form. The provider's central API key is selected by provider id and remains outside the plugin configuration UI (`elowen-plugin.json:19-24`; `PluginConfigEditor.tsx:530-540`).

# Reusable existing pattern

The correct host pattern is already in use:

- `usePluginConfigDraft` seeds from server state once per plugin name, avoids refetch overwriting an in-progress edit, serializes full-snapshot writes, validates JSON, and flushes pending edits on close/unmount (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-112`).
- `useAutoSaveStatus` provides the bounded debounce, `saving`/`saved`/`error` states, retry, and flush behavior (`/var/www/elowen/web/lib/useAutoSaveStatus.ts:6-30,45-105`).
- `AutoSaveStatus` renders accessible saving/saved/error+retry feedback (`/var/www/elowen/web/components/ui/AutoSaveStatus.tsx:7-27`).
- The generic plugin mutation invalidates the plugin detail/list and command catalog after success (`/var/www/elowen/web/lib/mutations.ts:283-288`).
- The server applies one shared patch rule, preserves absent keys, keeps write-only secrets, validates supported typed fields, persists before reload, and distinguishes delayed activation from a failed write (`/var/www/elowen/src/api/routes/plugins/index.ts:62-86,116-137,500-518`).

Image-edit should stay on this path; it does not need a custom web implementation.

# Tests and gaps

- Host autosave tests cover invalid JSON, write-only secrets, immediate commit failure/success, and serialized stale-write protection (`/var/www/elowen/web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105`).
- Host plugin route tests cover masked config, defaults, validation, persistence-before-reload, HTTP 202 pending activation, reload exceptions, and pre-persistence failures (`/var/www/elowen/tests/api/pluginRoutes.test.ts:103-177,339-380`).
- The registry suite loads image-edit with a fake central provider and checks overall tool registration and manifest/code parity (`/var/www/elowen-plugins/tests/toolNaming.test.ts:21-52,90-112`), but it does not invoke `EditImage`, exercise the provider/model config contract, verify data-dir output, or test external fetch failure handling.
- No image-edit-specific test file was found under `/var/www/elowen-plugins/plugins/image-edit`; its directory contains only the manifest, entry module, and locale files.
- There is no focused host test proving that a schema-driven provider/model autosave surfaces the server's `pending` activation result; the generic draft API currently has no pending-status channel for ordinary autosaves.
- There is no focused test asserting that the UI/API agree on the effective model default or that an empty required provider is rejected at the persistence boundary.

# Recommended migration notes

- Keep the plugin on the host schema-driven autosave; do not add a custom drawer or web bundle.
- Align the model contract by either adding `"default": "gpt-image-1"` to the manifest or changing the hint so the UI does not claim a prefilled value it cannot render.
- Extend the shared autosave feedback contract to preserve `pending` from ordinary config saves, then show “saved, activation pending” for provider/model edits just as the route contract promises. This should be fixed in the shared hook, not in image-edit.
- Decide whether `required` is intended to be an API-enforced invariant. If yes, enforce it centrally for declared required fields; otherwise document that the plugin intentionally degrades when provider configuration is absent.
- Declare the plugin's external network capability in the manifest so the read-only permissions panel reflects the actual `EditImage` data flow.
- Add focused registry tests for no-provider registration, model fallback, successful PNG persistence, and failed source/API requests; add a host regression test for pending activation feedback.
