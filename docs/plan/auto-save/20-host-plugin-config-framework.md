# Scope

This audit covers the host-side plugin configuration framework in `/var/www/elowen/web`, the plugin settings/page routing and account deck integration, and the browser plugin runtime. Supporting daemon and registry sources are cited where they establish persistence, validation, masking, ownership, or activation semantics.

The two configuration scopes are materially different:

- `configSchema` is instance-wide, administrator-owned configuration persisted through `/plugins/:name/config`.
- `userConfigSchema` is per-account configuration persisted through `/plugins/:name/user-config`; the current web host does not expose this scope in its client, types, or generic editor path.

## Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Installed-plugin enable/disable toggle | `/var/www/elowen/web/modules/settings/PluginsSection.tsx:81-141,194-211,271-277`; `/var/www/elowen/web/lib/mutations.ts:130-159`; `/var/www/elowen/src/api/routes/plugins/index.ts:520-538` | Immediate `PATCH /plugins/:name` through `usePluginConsent`/`useTogglePlugin`. The list and open detail are optimistic, errors roll back, and settle invalidates plugin list, detail, logs, commands, and UI listing. Enabling may require explicit grant acknowledgement; a deferred live swap is reported as pending. | Compliant |
| Admin plugin-detail config deck | `/var/www/elowen/web/modules/settings/PluginDetail.tsx:41-156`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:632-1015`; `/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-112` | `GET /plugins/:name` supplies `configSchema`, current `config`, and `secretsSet`. Every field change updates one shared draft and auto-saves a full snapshot after 900 ms. Writes are serialized, JSON is rejected before transmission, and `AutoSaveStatus` is shown in the deck toolbar with retry. | Compliant |
| Generic field rendering for `configSchema` | `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:658-760,764-833` and `835-915`; `/var/www/elowen/web/lib/types.ts:408-458` | Booleans, numbers, secrets, selectors, catalogs, token lists, text/code/prompt/JSON documents, role policies, MCP servers, and visibility guards all write through the same draft. Modal-backed fields remain controlled by the parent draft, so closing a modal does not discard edits. | Compliant |
| Instance secrets | `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:869-900`; `/var/www/elowen/web/lib/usePluginConfigDraft.ts:7-19,72-80`; `/var/www/elowen/src/api/routes/plugins/index.ts:417-434,500-517` | Stored secrets are represented only by `secretsSet`; they are not returned in `config`. An untouched secret is therefore absent from full-snapshot writes and the daemon keeps it. Replacing a secret writes the newly typed value. The daemon masks responses and treats empty/absent secret values as “keep existing”. | Partial |
| Microsoft Teams custom plugin workspace settings | `/var/www/elowen-plugins/plugins/msteams/web-src/TeamsWorkspace.tsx:409-535`; `/var/www/elowen-plugins/plugins/msteams/web-src/TeamsWorkspace.tsx:281-307`; `/var/www/elowen-plugins/plugins/msteams/elowen-plugin.json:159-322` | The bundle obtains `usePluginDetail('msteams')` and the host `usePluginConfigDraft`; its Settings tab embeds the host `PluginConfigEditor`. The People & access tab edits `rolePolicies` in the same draft, so role toggles/prompts also use the 900 ms full-snapshot autosave. Global settings intentionally filter out the custom role-policy section while retaining the value in the shared draft. | Compliant |
| Plugin settings page routing / former settings deck | `/var/www/elowen/web/app/settings/page.tsx:122-163,385-387,519-530`; `/var/www/elowen/web/modules/settings/pluginSections.ts:1-18`; `/var/www/elowen/web/lib/pluginNav.ts:5-15,17-51` | The current Settings deck is core-only. Plugin setting metadata comes from `/plugins/ui`; old `plugin:<name>:<id>` selections are forwarded to `/p/<plugin>` or `/p/<plugin>/settings/<id>`. No plugin settings component is mounted inside the core Settings deck today. | N/A |
| Standalone plugin settings page host | `/var/www/elowen/web/app/p/[plugin]/[[...rest]]/page.tsx:25-57,88-144`; `/var/www/elowen/web/modules/account/PluginAccountSection.tsx:21-63` | The host loads the same-origin bundle, resolves a declared settings component, passes `surface="page"`, and supplies a page frame/header when the bundle does not own one. A page-hosted settings component receives a save-state channel, so errors remain visible and retryable outside the old deck. Account panels use `surface="deck"` and receive only the bundle component props. | Compliant for host lifecycle; missing for per-user config |
| Skills settings register | `/var/www/elowen-plugins/plugins/skills/web-src/SkillsSettings.tsx:18-41,73-201` | Explicit Save is used for create/edit/delete of Markdown assets, including ownership moves. The row toggle is an immediate mutation. This is a multi-field/file operation with ordering and ownership constraints, not a simple settings record. | Explicit-save justified |
| Cron jobs register | `/var/www/elowen-plugins/plugins/cronjob/web-src/JobsSettings.tsx:246-321,333-365,447-550` | Each row has a local draft and auto-saves after 900 ms once name, prompt, and schedule are valid. Writes are guarded against delete races and stale server copies; delete and Run now remain explicit actions. Enabled is part of the auto-saved row snapshot. | Compliant |
| MCP server editor | `/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:169-305,357-395,450-469,593-609`; `/var/www/elowen-plugins/plugins/mcp/elowen-plugin.json:106-135` | Explicit Save persists a server. Scope changes are a separate transfer performed before the PATCH, and the editor can create, move, reconnect, or delete external/local server definitions. This is a multi-step resource operation rather than a plain form snapshot. | Explicit-save justified |
| GitHub linked-account panel | `/var/www/elowen-plugins/plugins/github/elowen-plugin.json:78-111`; `/var/www/elowen-plugins/plugins/github/web-src/GitHubConnectionPanel.tsx:9-56,89-150`; `/var/www/elowen/web/modules/account/PluginAccountSection.tsx:42-63` | The panel performs device authentication, replacement, disconnect, and externally verified action confirmation through plugin API routes. It has no generic config editor and no `userConfigSchema` form. Explicit actions are appropriate for credential and external-account operations. | Explicit-save justified |
| Per-account `userConfigSchema` generic form | Host type/client/editor search: `/var/www/elowen/web/lib/types.ts:325-351,408-458`; `/var/www/elowen/web/lib/elowenClient.ts:126-143`; `/var/www/elowen/web/lib/usePluginConfigDraft.ts:43-112`; registry example `/var/www/elowen-plugins/plugins/github/elowen-plugin.json:78-99` | The daemon supports a caller-owned listing and PATCH, but the web client has no `/plugins/user-config` query or `/plugins/:name/user-config` mutation, `PluginDetail` has only `configSchema`, and `PluginAccountSection` passes no schema/config to account components. The generic draft defaults to `useSavePluginConfig`, which is the administrator instance route. | Missing |

## Missing or inconsistent auto-save

### `userConfigSchema` is implemented in the daemon but absent from the host web contract

The daemon exposes the correct per-account lifecycle: `/plugins/user-config` lists only enabled and permitted plugins with a `userConfigSchema`, and `/plugins/:name/user-config` applies a validated patch against the signed-in account (`/var/www/elowen/src/api/routes/plugins/index.ts:358-415`). The store is one JSON row per `(user, plugin)` and replaces it atomically (`/var/www/elowen/src/store/userPluginConfigStore.ts:3-36`). Secrets are masked, empty secret values preserve the stored secret, and `null` clears non-secret values (`/var/www/elowen/src/api/routes/plugins/index.ts:392-414`; `/var/www/elowen/tests/api/pluginUserConfig.test.ts:85-131`).

The web side has no corresponding path:

- `PluginUiListing.account` contains only panel metadata, not user config schema/value data (`/var/www/elowen/web/lib/types.ts:325-351`).
- `PluginDetail` models only the admin response (`configSchema`, `config`, `secretsSet`) (`/var/www/elowen/web/lib/types.ts:479-488`).
- `elowenClient` exposes `pluginDetail` and `savePluginConfig`, but no user-config methods (`/var/www/elowen/web/lib/elowenClient.ts:126-143`).
- `PluginAccountSection` mounts an account component with identity/surface props only (`/var/www/elowen/web/modules/account/PluginAccountSection.tsx:54-63`).
- `usePluginConfigDraft` defaults to `useSavePluginConfig` and therefore targets the instance-wide admin route (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:43-50,66-80`).

GitHub is the concrete shipped gap: its manifest declares `userConfigSchema.mergeMethod` (`/var/www/elowen-plugins/plugins/github/elowen-plugin.json:78-99`) and runtime code reads it through `ctx.userConfig()` (`/var/www/elowen-plugins/plugins/github/src/service.ts:600-603`), but its Account panel only handles GitHub authentication and external actions (`/var/www/elowen-plugins/plugins/github/web-src/GitHubConnectionPanel.tsx:9-56,121-150`). The per-user merge preference has no host UI and cannot be auto-saved through the current runtime.

### Secret replacement leaves plaintext in the mounted draft after success

The masking boundary is correct on the network and daemon response, but after a user replaces a secret, the input remains controlled by `draft.values[f.key]` and `replacingSecrets` is never cleared (`/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:656,869-900`). Query invalidation cannot re-seed the same plugin draft by design (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-63`). Consequently, the newly entered secret can remain in React state and visible in the password field until the workspace is unmounted or the user leaves replacement mode. This is not a persistence leak to the API, but it is inconsistent with the stated write-only UX and lacks a focused regression test.

### Settings-deck terminology no longer matches the host topology

Plugin bundles still implement `surface="deck"` branches, for example Skills (`/var/www/elowen-plugins/plugins/skills/web-src/SkillsSettings.tsx:73-80,205-207`) and Cron (`/var/www/elowen-plugins/plugins/cronjob/web-src/JobsSettings.tsx:723-748`). The host Settings page explicitly keeps the rail core-only and redirects legacy plugin IDs (`/var/www/elowen/web/app/settings/page.tsx:153-163`; `/var/www/elowen/web/tests/app/settingsPluginSections.test.tsx:43-81`). This is not an autosave failure by itself, but it creates a stale integration contract: a bundle can support a deck surface that the current host no longer mounts. The active plugin settings path is the standalone page, except for account panels mounted in the Account deck.

## Legitimate exceptions

- Plugin enable/disable is an operational capability boundary, not a draft field. Immediate mutation, optimistic state, grant consent, rollback, and pending activation are appropriate (`/var/www/elowen/web/modules/settings/usePluginConsent.tsx:24-31,65-108`).
- Secrets and externally verified credentials should not be treated as ordinary visible fields. GitHub device auth and replacement/disconnect actions are deliberately explicit (`/var/www/elowen-plugins/plugins/github/web-src/GitHubConnectionPanel.tsx:22-55,89-99`).
- Skills create/edit/delete includes file persistence and optional ownership movement, so one explicit commit is safer than independently saving half of a document/move (`/var/www/elowen-plugins/plugins/skills/web-src/SkillsSettings.tsx:166-200`).
- MCP server edits may transfer ownership scope before patching and may start local processes; explicit Save, reconnect, and delete preserve operation boundaries (`/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:366-395,397-469`).
- Cron delete and Run now are destructive or externally consequential actions; the ordinary row fields, including `enabled`, are already auto-saved (`/var/www/elowen-plugins/plugins/cronjob/web-src/JobsSettings.tsx:305-321,338-365`).

## Reusable existing pattern

`useAutoSaveStatus` is the host's canonical controller (`/var/www/elowen/web/lib/useAutoSaveStatus.ts:6-30,45-105`). It provides:

- a seed guard (`ready`) so initial server data is never written back;
- bounded debounce with an explicit `flush()` on close/unmount;
- `idle`/`saving`/`saved`/`error` state and `retry()`;
- queued latest-state serialization while a request is in flight;
- a separate `savable` gate for invalid forms.

`usePluginConfigDraft` adds the plugin-specific invariants (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-112`): full snapshots, JSON validation, serialized PATCHes, immediate confirmed commits for destructive structured-row removal, and protection against refetches overwriting a newer draft. The same hook is reused by the host plugin detail and the Teams bundle, which is the correct single-source behavior for `configSchema`.

For per-account forms, the existing hook already accepts an injected save function (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:43-49`). The missing pieces are a user-config query/type, a user-config mutation targeting the caller's account, and account-panel plumbing that supplies `userConfigSchema`, masked values, and `secretsSet` without ever falling back to instance config.

## Tests and gaps

Existing focused coverage proves the important instance path:

- debounce, invalid JSON rejection, untouched-secret preservation, immediate commit semantics, delayed activation, and stale full-snapshot ordering: `/var/www/elowen/web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105`;
- direct boolean/number/slider/timezone/token-list/provider and modal document saves: `/var/www/elowen/web/tests/modules/settings/PluginDetail.test.tsx:199-394`;
- host settings-page forwarding and core-only deck behavior: `/var/www/elowen/web/tests/app/settingsPluginSections.test.tsx:43-81`;
- standalone plugin-page save-state propagation and Retry behavior: `/var/www/elowen/web/tests/app/pluginHostPage.test.tsx:141-209`;
- runtime publication of `PluginConfigEditor`, `usePluginConfigDraft`, `useAutoSaveStatus`, and `useSavePluginConfig`: `/var/www/elowen/web/tests/lib/pluginUi.test.ts:15-63,104-134`;
- daemon per-account isolation, masking, secret retention, validation atomicity, grants, and cleanup on account deletion: `/var/www/elowen/tests/api/pluginUserConfig.test.ts:85-219`.

Gaps relevant to this audit:

- no web test or client contract for `/plugins/user-config` or `/plugins/:name/user-config`;
- no account-panel test proving a `userConfigSchema` field is rendered and saved for the current account;
- no test proving a per-account secret remains masked through a host form and does not target `/plugins/:name/config`;
- no regression test for clearing the replacement secret input/state after an acknowledged save;
- no contract test ensuring a plugin declaring `userConfigSchema` receives a user-config-capable runtime path;
- existing runtime freeze tests protect the published names but do not distinguish instance config hooks from the absent user-config hooks (`/var/www/elowen/web/tests/lib/pluginUi.test.ts:82-175`).

## Recommended migration notes

1. Add typed host query/mutation methods for the daemon's per-account endpoints, with a separate `UserPluginConfigDetail` shape. Keep it distinct from `PluginDetail` so instance config cannot be selected accidentally.
2. Extend the Account/plugin runtime contract to deliver the caller's `userConfigSchema`, masked values, and `secretsSet`, and provide a save callback or dedicated user-config draft hook. The default save target must be `/plugins/:name/user-config`, never `/plugins/:name/config`.
3. Reuse `usePluginConfigDraft`'s debounce, validation, serialization, stale-refresh protection, and status reporting through an injected per-account save function. Preserve the daemon's full-snapshot semantics so untouched secrets remain untouched.
4. Mount the generic editor only for account panels that actually declare `userConfigSchema`; retain custom GitHub identity actions separately from the merge-method preference field.
5. Clear the local replacement secret value and exit replacement mode after a successful acknowledged write, while retaining the existing write-only `secretsSet` display.
6. Add focused web tests for per-account isolation, masked secrets, wrong-endpoint protection, autosave status/retry, refetch-vs-draft behavior, and the GitHub `mergeMethod` field. Keep the existing explicit-save exceptions for credentials, resource moves, destructive actions, and externally verified operations.
