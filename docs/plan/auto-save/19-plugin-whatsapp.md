# Scope

Audit of the registry `whatsapp` plugin's web UI, schema-driven configuration surfaces, drawer/modal interactions, and persistence APIs. The plugin has one custom web settings section (`pairing`) and one instance-wide `configSchema`; it has no `userConfigSchema`.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Connection configuration: pairing phone number, allowed groups, notification chat | `/var/www/elowen-plugins/plugins/whatsapp/elowen-plugin.json:30-54`; host rendering `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:918-946,961-1006` | Schema-driven inputs update the shared draft; `usePluginConfigDraft` debounces a full config snapshot by 900 ms, serializes writes, validates before sending, flushes on unmount, and exposes retry/status (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:43-112`). | Compliant |
| Reply and behavior configuration: response gating, streaming, activity replacement, reactions, footer, reasoning, language | `/var/www/elowen-plugins/plugins/whatsapp/elowen-plugin.json:56-123`; host controls `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:660-755` | Boolean, enum, and text changes all call the same draft setter and therefore use the shared 900 ms autosave. The workspace toolbar exposes saving/saved/error plus retry (`/var/www/elowen/web/modules/settings/PluginDetail.tsx:102-111`). | Compliant |
| Conversation configuration: vision model | `/var/www/elowen-plugins/plugins/whatsapp/elowen-plugin.json:125-135`; model control `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:712-717` | Shared model picker writes into the same autosaved draft; query invalidation refreshes plugin detail and brain commands after success (`/var/www/elowen/web/lib/mutations.ts:283-288`). | Compliant |
| Advanced media limits: image byte/image-count caps and ask timeout | `/var/www/elowen-plugins/plugins/whatsapp/elowen-plugin.json:137-186`; numeric control `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:665-708` | Numeric edits autosave after debounce. Server-side validation enforces finite values, min/max, and step before persistence (`/var/www/elowen/src/api/routes/plugins/index.ts:20-40,73-86`). WhatsApp bounds are declared in the manifest (`maxImageBytes`, `maxImages`, `maxUploadImages`, `askTimeoutMs`). | Compliant |
| Sender policies editor and policy fields | `/var/www/elowen-plugins/plugins/whatsapp/elowen-plugin.json:188-198`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:337-425,810-816` | Add/edit/toggle/prompt changes update the draft and autosave. Removing a policy uses a confirmation dialog and an immediate `commitValue`, which is appropriate for a permissions change; failure preserves the draft and displays an error through the shared status path. | Compliant |
| Pairing settings section and device action | `/var/www/elowen-plugins/plugins/whatsapp/elowen-plugin.json:200-224`; `/var/www/elowen-plugins/plugins/whatsapp/web-src/index.tsx:7-15`; `/var/www/elowen-plugins/plugins/whatsapp/web-src/PairingSettings.tsx:9-55` | Pair and unpair are explicit external-account actions, not editable preferences. The linked state is read from `GET /plugins/whatsapp/pairing`; pair/unpair use explicit `POST` actions. Unpair is confirmation-gated. | Explicit-save justified |
| Pairing QR/code modal and refresh action | `/var/www/elowen-plugins/plugins/whatsapp/web-src/PairingSettings.tsx:57-127` | `POST /plugins/whatsapp/pair` starts a fresh pairing attempt; the modal polls `GET /plugins/whatsapp/pairing` every 1.5 seconds and stops when connected. QR/code state is in-memory; Baileys credentials are persisted under the plugin data directory through `saveCreds` (`/var/www/elowen-plugins/plugins/whatsapp/lib/adapter.mjs:138-159,176-199`). | Explicit-save justified |
| Plugin capability/activity tabs and plugin data drawer | `/var/www/elowen/web/modules/settings/PluginDetail.tsx:141-153`; `/var/www/elowen/web/modules/settings/PluginDataPanel.tsx:25-67` | Capabilities, logs, and hook activity are read-only. Data clearing is a separate confirmation-gated destructive action, not a form save; it calls the host `POST /plugins/:name/data/clear` route (`/var/www/elowen/src/api/routes/plugins/index.ts:485-497`). | N/A |

# Missing or inconsistent auto-save

- The instance-wide WhatsApp configuration is consistently covered by the host's canonical autosave controller. There is no plugin-local Save button, competing persistence path, or manual form submission.
- Full-snapshot writes are serialized, so a slow older PATCH cannot finish after a newer edit and roll the server back (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:52-70`). Refetches do not reseed an active draft unless the plugin name changes (`:59-65`), protecting edits from query invalidation races.
- Invalid JSON is not relevant to this plugin, but the shared controller still reports save errors rather than claiming success. Server validation covers WhatsApp numeric fields and token-list shape; `groupIds` also has legacy string/array compatibility in the adapter (`/var/www/elowen-plugins/plugins/whatsapp/lib/adapter.mjs:33-37`).
- Semantic validation is incomplete at the generic config boundary: the WhatsApp manifest declares `phoneNumber`, `notifyChat`, and `senderPolicies`, but the shared write path only performs specialized validation for numbers, timezones, and token lists (`/var/www/elowen/src/api/routes/plugins/index.ts:73-86`). It does not visibly validate phone/JID syntax or policy contents before an autosaved value is accepted.
- The pairing modal has an adjacent action-state gap rather than an autosave defect: when polling or the initial pair request fails, it shows `pairError`, but the `New code` retry button is hidden whenever `error` is true (`/var/www/elowen-plugins/plugins/whatsapp/web-src/PairingSettings.tsx:93-125`). The user must close and reopen the modal.
- Unpair failures are swallowed and only followed by a status refresh (`/var/www/elowen-plugins/plugins/whatsapp/web-src/PairingSettings.tsx:25-29`), so an API failure has no dedicated error or retry affordance.

# Legitimate exceptions

- Pairing is an external credential/linking flow. It requires an explicit user action and live polling; autosaving it would be incorrect.
- Unpair logs out an external account and deletes local authentication state (`/var/www/elowen-plugins/plugins/whatsapp/lib/adapter.mjs:162-174`), so confirmation and explicit execution are required.
- Sender-policy deletion changes admission/admin permissions and is confirmation-gated with an immediate commit; ordinary policy edits remain autosaved.
- Clearing plugin data is destructive and correctly uses a confirmation dialog rather than autosave (`/var/www/elowen/web/modules/settings/PluginDataPanel.tsx:47-55`).

# Reusable existing pattern

Use the host pattern already consumed by WhatsApp configuration:

- `usePluginConfigDraft` owns one draft, 900 ms bounded debounce, full-snapshot serialization, seed protection, unmount flush, and retry (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-112`).
- `useAutoSaveStatus` provides `idle`, `saving`, `saved`, and `error` states, stale-write protection, flush, and retry (`/var/www/elowen/web/lib/useAutoSaveStatus.ts:6-30,45-105`).
- `PluginDetail` places the status indicator in the persistent workspace toolbar, so it remains visible while switching setup, behavior, and advanced tabs (`/var/www/elowen/web/modules/settings/PluginDetail.tsx:102-111`).
- The server PATCH route persists before attempting live reload and returns `202 { pending: true }` when activation is delayed, allowing the UI to distinguish durable save from delayed runtime activation (`/var/www/elowen/src/api/routes/plugins/index.ts:126-137,500-518`).

# Tests and gaps

- WhatsApp-specific route tests cover the real pairing routes, admin authorization, unpaired state, and disabled-plugin responses (`/var/www/elowen-plugins/tests/whatsappPairingRoutes.test.ts:49-70`).
- WhatsApp tests cover legacy and array `groupIds` representations (`/var/www/elowen-plugins/tests/whatsappCommands.test.ts:7-14`) and broader adapter behavior, but there are no plugin-local web tests for `PairingSettings`.
- Host autosave tests cover invalid JSON, write-only secrets, immediate confirmed commits, pending activation, serialized full snapshots, and saved status (`/var/www/elowen/web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105`). Editor tests cover role-policy removal failure/success and pending activation (`/var/www/elowen/web/tests/modules/settings/PluginConfigEditor.test.tsx:94-122`).
- No test exercises every WhatsApp manifest field through the actual WhatsApp detail surface and PATCH route. Generic host route tests cover the validation machinery, but not the WhatsApp-specific numeric bounds or a real `senderPolicies` snapshot.
- No UI test proves pairing error recovery, visible unpair failure, polling cleanup on close, or behavior when the adapter is disabled after the modal opens.
- The generic data-clear route deletes the plugin data directory contents while the live adapter may retain in-memory auth/state; the WhatsApp-specific lifecycle semantics of clearing `auth/` and `channel-state.json` are not covered by the audited tests.

# Recommended migration notes

- Keep all WhatsApp config fields on the shared autosave path; no migration to per-field mutations or a plugin-specific Save button is warranted.
- Add WhatsApp-specific boundary validation for phone numbers/JIDs and sender-policy structure, or explicitly document that these fields are intentionally permissive. This is the main persistence-integrity gap.
- Add a retry action to the pairing error state and surface unpair failures with an actionable retry or a clear failed-state message. These are explicit-action UX fixes, not autosave changes.
- Define and test the live behavior of the generic data-clear action for WhatsApp, especially whether clearing `auth/` requires an adapter reset/reload before reporting completion.
- Add a focused web regression suite for pairing modal lifecycle/error states and a route test that saves the actual WhatsApp schema, including number bounds, token lists, and a representative sender-policy snapshot.
