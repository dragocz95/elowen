# Scope

Audit of the registry `web` plugin at `/var/www/elowen-plugins/plugins/web`, including its manifest-declared configuration, the host web settings surfaces that render it, drawers/modals, and the persistence APIs used by those surfaces. The registry plugin contains only `elowen-plugin.json`, `index.mjs`, and Czech/Slovak i18n files; it declares no `web` contribution, `web-src`, account config, or project config.

The plugin declares four instance-wide fields: `provider` (enum, default `auto`), `tavilyApiKey` (secret), `serperApiKey` (secret), and `maxResults` (number) (`/var/www/elowen-plugins/plugins/web/elowen-plugin.json:8-12`).

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Settings → Plugins installed list / `web` card | `/var/www/elowen/web/modules/settings/PluginsSection.tsx:81-145,194-271,348-360` | Enable/disable is an immediate `PATCH /plugins/:name` mutation, optimistic in the list/detail cache, with rollback on error and toast feedback (`/var/www/elowen/web/lib/mutations.ts:130-159`; `/var/www/elowen/web/modules/settings/PluginsSection.tsx:274-285`). | Compliant |
| Plugin detail workspace shell | `/var/www/elowen/web/modules/settings/PluginDetail.tsx:94-156,161-171` | Detail is loaded through `usePluginDetail`; Setup/Behavior tabs share one draft. The toolbar exposes `AutoSaveStatus`, including saving, saved, error and retry states (`PluginDetail.tsx:102-112`; `/var/www/elowen/web/components/ui/AutoSaveStatus.tsx:7-27`). Loading and detail errors have explicit states and retry (`PluginDetail.tsx:163-171`). | Compliant |
| Setup → Search provider enum | Registry manifest `/var/www/elowen-plugins/plugins/web/elowen-plugin.json:9`; renderer `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:743-751` | Choice control updates the shared draft. Changes are debounced for 900 ms, serialized, and sent as a full snapshot (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:52-80`). | Partial — the UI restricts choices, but the API does not validate enum membership. |
| Setup → Tavily API key | Registry manifest `/var/www/elowen-plugins/plugins/web/elowen-plugin.json:10`; renderer `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:869-900` | Stored secrets are never returned or displayed; the row shows “set” and requires an explicit Replace action before exposing a password input. A newly typed replacement then uses the same 900 ms autosave draft. | Compliant — the Replace gate is a justified credential-safety exception, not an explicit Save flow. |
| Setup → Serper API key | Registry manifest `/var/www/elowen-plugins/plugins/web/elowen-plugin.json:11`; renderer `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:869-900` | Same masked, write-only, Replace-then-autosave behavior as Tavily. | Compliant — same justified credential handling. |
| Behavior → Search results (`maxResults`) | Registry manifest `/var/www/elowen-plugins/plugins/web/elowen-plugin.json:12`; renderer `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:664-708`; runtime `/var/www/elowen-plugins/plugins/web/index.mjs:143-145` | Number input changes autosave after 900 ms. The registry manifest supplies only a hint; the runtime silently falls back to `5` for values below `1` and clamps values above `10`. | Partial — persistence is automatic, but the registry schema does not express the runtime bounds, so UI/API/runtime behavior is inconsistent. |
| Drawer/modal surfaces | Registry manifest `/var/www/elowen-plugins/plugins/web/elowen-plugin.json:8-12`; modal type gate `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:51-58,843-865` | None for this plugin. Its fields are enum, secret and number; none is a modal-backed document/list field. | N/A |
| Plugin detail read API | Client `/var/www/elowen/web/lib/elowenClient.ts:126-135`; query `/var/www/elowen/web/lib/queries.ts:251-266`; route `/var/www/elowen/src/api/routes/plugins/index.ts:417-435` | `GET /plugins/web` returns schema and non-secret values, pre-filling declared defaults, while returning only `secretsSet` for secrets. The route is admin-gated. | Compliant |
| Plugin config write API | Client `/var/www/elowen/web/lib/elowenClient.ts:133-135`; route `/var/www/elowen/src/api/routes/plugins/index.ts:500-518` | `PATCH /plugins/web/config` receives `{ values }`, merges only declared keys, preserves empty/null secrets, persists before reload, and returns `202 {pending:true}` when live activation is deferred (`index.ts:62-87,116-123`). | Partial — durable, serialized autosave is present, but generic validation does not enforce the enum/type contract for this manifest. |
| Plugin-owned web/nav/settings/account/project surfaces | Registry plugin directory listing and manifest; `/var/www/elowen-plugins/plugins/web/elowen-plugin.json:1-13` | No `web` manifest block, browser bundle, nav entry, settings contribution, account section, user section, project section, or user config schema exists. | N/A |

# Missing or inconsistent auto-save

- **The registry manifest is weaker than the runtime contract for `maxResults`.** The registry version has only `type: "number"` and a default (`/var/www/elowen-plugins/plugins/web/elowen-plugin.json:12`). The plugin runtime applies `1..10` and otherwise falls back/clamps (`/var/www/elowen-plugins/plugins/web/index.mjs:143-145`). Therefore the generated input has no `min`, `max`, or `step` attributes, and the API can persist values the runtime will not honor. The host's checked-in copy of the same plugin currently contains `min: 1`, `max: 10`, `step: 1`, and a slider (`/var/www/elowen/plugins/web/elowen-plugin.json:49-59`), proving a registry/host schema drift for version `0.3.0`.
- **Enum validation is client-only.** `applyConfigPatch` validates numbers, timezones and token lists, but has no enum/options validation or general field-type validation (`/var/www/elowen/src/api/routes/plugins/index.ts:22-40,62-87`). A direct `PATCH /plugins/web/config` can store an arbitrary provider string. The plugin then reports an unknown-provider message at runtime rather than the API rejecting the invalid configuration (`/var/www/elowen-plugins/plugins/web/index.mjs:122-133`). This is a persistence API integrity gap, even though the normal web control cannot produce it.
- **Secret clearing is intentionally unavailable.** The server treats empty or null secret values as “keep the stored secret” (`/var/www/elowen/src/api/routes/plugins/index.ts:62-77`), matching the write-only UI. This is appropriate for preventing accidental deletion during full-snapshot autosaves, but there is no explicit clear operation if credential removal is required.
- **The autosave controller itself has strong draft protection.** It avoids saving the initial seed, serializes writes, collapses rapid edits, flushes on teardown, and exposes retry (`/var/www/elowen/web/lib/useAutoSaveStatus.ts:7-17,45-67,70-105`). The plugin draft additionally avoids refetch clobbering and serializes full-snapshot mutations (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-70`). No missing debounce, stale-response, or navigation-loss defect was found in the shared path.

# Legitimate exceptions

- API keys are write-only credentials. Hiding an existing value and requiring Replace before editing is justified; returning the secret would violate the host's credential boundary. The backend masks all secret values and reports only their presence (`/var/www/elowen/src/api/routes/plugins/index.ts:89-105`).
- Enabling/disabling a plugin is an immediate operational mutation rather than a draft form. The list uses optimistic feedback and rollback, while the backend persists before hot-reload and distinguishes deferred activation with HTTP 202 (`/var/www/elowen/web/lib/mutations.ts:130-159`; `/var/www/elowen/src/api/routes/plugins/index.ts:116-123,520-529`).
- WebFetch itself requires no configuration and has no separate settings surface; the plugin's config only affects WebSearch (`/var/www/elowen-plugins/plugins/web/index.mjs:1-2,143-205`).

# Reusable existing pattern

The canonical pattern is already in the host:

1. Schema-driven records render controls through `PluginConfigEditor` (`/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:632-760`).
2. `usePluginConfigDraft` owns one snapshot, 900 ms debounce, JSON sanitization, serialized writes, refetch protection, and immediate commit support (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-112`).
3. `useAutoSaveStatus` provides seed suppression, queued latest-state writes, teardown flush, and retryable status (`/var/www/elowen/web/lib/useAutoSaveStatus.ts:7-17,45-105`).
4. `AutoSaveStatus` renders accessible saving/saved/error feedback (`/var/www/elowen/web/components/ui/AutoSaveStatus.tsx:7-27`).
5. `useSavePluginConfig` invalidates the plugin detail, installed list, and brain command cache after success (`/var/www/elowen/web/lib/mutations.ts:283-288`).

# Tests and gaps

- Generic autosave behavior is covered, including seed suppression, status transitions, retry, unmount flush, hidden-panel retention, and stale completion ordering (`/var/www/elowen/web/lib/useAutoSaveStatus.test.tsx:6-104`).
- Plugin detail tests cover direct autosave, canonical number values, slider behavior, full-snapshot preservation, document-editor autosave, and secret masking/Replace behavior (`/var/www/elowen/web/tests/modules/settings/PluginDetail.test.tsx:174-205,207-266,383-449`).
- Backend route tests cover secret preservation, explicit non-secret clearing, numeric bounds/steps when declared, persistence-before-reload, deferred activation, and masked GET responses (`/var/www/elowen/tests/api/pluginRoutes.test.ts:103-177,243-255,339-381`).
- The web plugin runtime tests cover Tavily/Serper selection, automatic provider choice, missing-key guidance, and request payloads (`/var/www/elowen/tests/plugins/webPlugin.test.ts:35-84`).
- **Gap:** no focused test loads the actual registry manifest from `/var/www/elowen-plugins/plugins/web` through the host UI and asserts the four resulting controls and autosave payloads.
- **Gap:** no route test asserts invalid `provider` option rejection for the web plugin, and no test asserts the registry's `maxResults` contract against its runtime clamp. The current route tests use a separate fixture manifest with declared numeric bounds.
- This audit did not execute the test suite; findings are based on source and existing focused test coverage.

# Recommended migration notes

- Keep the existing shared autosave path; it already satisfies debounce, visible status, retry, stale-draft protection, and teardown flushing for this plugin.
- Reconcile the registry `web` manifest with the runtime contract and the host copy: declare `maxResults` bounds/step (and slider metadata only if that is the intended UX), so generated controls and server validation agree with `index.mjs`.
- Treat `provider` options as a server-side validation concern as well as a UI concern; otherwise API callers can persist a value that the runtime can only explain as misconfiguration.
- Add a manifest-backed UI regression and API validation regression using the real `web` plugin artifact, plus an explicit product decision on whether credential removal needs a separate clear action.
