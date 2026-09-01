# Scope

Audited the registry plugin `msteams` under `/var/www/elowen-plugins/plugins/msteams`, its custom web workspace, manifest-driven configuration, shared host settings surface, drawer/modal-backed editors, and all plugin-owned persistence APIs. The host persistence implementation was inspected in `/var/www/elowen`, especially `usePluginConfigDraft`, `useAutoSaveStatus`, `PluginConfigEditor`, and the plugin API routes.

The plugin has one custom page (`web-src/index.tsx:4-6`) with two tabs, `People & access` and `Settings` (`web-src/TeamsWorkspace.tsx:487-535`). There is no plugin-specific drawer implementation; model, collection, destination, secret, and role-policy drawers/modals are supplied by the shared host editor.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Custom Teams workspace shell and global status | `web-src/TeamsWorkspace.tsx:409-535` | One draft is created with `usePluginConfigDraft('msteams', detail)` (`:413`); `AutoSaveStatus` is rendered in the hero (`:465-470`) and exposes retry through the shared draft. | Compliant |
| Settings tab: Connection | `web-src/TeamsWorkspace.tsx:521-532`; manifest `elowen-plugin.json:159-203` | `PluginConfigEditor` edits `appId`, write-only `appPassword`, `tenantId`, `accountLinking`, and conditional `oauthConnectionName` through the shared debounced draft. | Compliant |
| Settings tab: Microsoft SSO | manifest `elowen-plugin.json:205-322` | Booleans, enum, model/collection selectors and conditional fields all call the shared editor's `draft.setValue`; saves use the same debounced full-snapshot PATCH. | Compliant |
| Settings tab: Microsoft 365, branding, proactive messaging | manifest `elowen-plugin.json:324-409` | `m365AccessMode`, transfer limit, app names/icon path, destination, Graph lookup and catalog ID use the shared editor and autosave. `Download app package` is a separate immediate GET action, not a save. | Compliant |
| Settings tab: Replies and behavior | manifest `elowen-plugin.json:411-547` | Toggles and enums (`toolActivity`, `answerMode`, `toolOutput`, `toolMessageMode`, reactions, footer, reasoning, language) autosave through the shared draft. | Compliant |
| Settings tab: Conversation and media | manifest `elowen-plugin.json:549-617` | Bounded number fields, model selector, booleans and conditional fields autosave through the shared editor. | Compliant |
| People & access register: search/filter/selection | `web-src/TeamsWorkspace.tsx:269-347`, `:423-429` | Search, filter and selected person are local UI state only; they do not represent persisted edits. | N/A |
| People & access: create, edit, toggle and prompt for a direct role policy | `web-src/TeamsWorkspace.tsx:281-307`, `:370-398`; manifest `elowen-plugin.json:619-630` | `rolePolicies` is kept in the same shared draft. Create, admin toggle and prompt changes call `draft.setValue` and persist after the shared debounce; the hero shows saving/saved/error/retry. | Compliant |
| Role-policy drawer/modal in generic host editor | `web/modules/settings/PluginConfigEditor.tsx:810-817`; role editor `:337-425` | The shared `RolePoliciesEditor` autosaves edits through the same draft. Removal is confirmed and uses `draft.commitValue` for an immediate full-snapshot write (`:354-362`, `:815`). | Compliant; removal is Explicit-save justified |
| Generic Settings → Plugins detail workspace | `web/modules/settings/PluginDetail.tsx:58-64`, `:92-152` | The generic management surface also creates `usePluginConfigDraft` and renders `PluginConfigEditor`; it receives the full msteams schema, including `rolePolicies`, and exposes the same status at `:103-112`. | Compliant |
| Identity card: account status/profile | `web-src/TeamsWorkspace.tsx:116-154`; API `index.mjs:136-143` | Read-only GET on person selection; the response is projected into local `PeopleResponse` state without secrets. | N/A |
| Identity card: link/change Elowen account | `web-src/TeamsWorkspace.tsx:150-165`, `:230-243`; API `index.mjs:145-161` | Explicit immediate `PATCH /plugins/msteams/people/:id/account`; replacement opens `ConfirmDialog` (`:257-264`). Local pending and error feedback is shown. | Explicit-save justified |
| Identity card: force new Microsoft sign-in | `web-src/TeamsWorkspace.tsx:167-176`, `:203-205`; API `index.mjs:163-171` | Explicit immediate `POST /plugins/msteams/people/:id/signout`; local pending/error feedback is shown. This invalidates an external token session rather than editing ordinary plugin config. | Explicit-save justified |
| Known-people/avatar/package APIs | `index.mjs:100-121`, `:124-135`, `:173-183` | GET-only reads/downloads. They do not persist form edits; package failures return an HTTP error for the browser navigation. | N/A |
| Instance config persistence API | Host `src/api/routes/plugins/index.ts:500-518`; client `web/lib/elowenClient.ts:134-135`; mutation `web/lib/mutations.ts:283-288` | Admin-only PATCH accepts a values snapshot, preserves write-only secrets, persists before hot reload, and returns `202 pending` when activation is delayed. | Partial |
| Identity persistence API | `index.mjs:145-171`; `lib/accountLinking.mjs:228-264` | Account binding delegates to the core external-user identity store; sign-out delegates to Bot Framework Token Service. Both are explicit, bounded mutations rather than debounced config writes. | Explicit-save justified |

# Missing or inconsistent auto-save

- The ordinary configuration path is consistently autosaved. The custom workspace shares one draft between both tabs (`web-src/TeamsWorkspace.tsx:413`), removes `rolePolicies` from the global Settings editor to avoid a second editor in that workspace (`:50-56`), and places one status indicator in the hero (`:465-470`).
- The shared draft has the required safeguards: it does not let refetch overwrite an active draft (`web/lib/usePluginConfigDraft.ts:37-42`), serializes full-snapshot writes (`:52-70`), validates JSON before saving (`:72-80`), flushes before immediate commits (`:83-101`), and exposes retry/flush/status (`:104-112`).
- The shared autosave controller uses bounded debounce, visible terminal states, queued latest-state writes, retry, and unmount flush (`web/lib/useAutoSaveStatus.ts:7-17`, `:45-67`, `:70-102`). `AutoSaveStatus` renders saving, saved, and error-with-retry states (`web/components/ui/AutoSaveStatus.tsx:7-26`).
- Validation is the main persistence gap. The msteams role-policy editor allows a newly added row with an empty `roleId` and immediately autosaves it (`web/modules/settings/PluginConfigEditor.tsx:353-354`), while the manifest only documents the required identifier semantics (`elowen-plugin.json:625-628`). There is no client-side `savable` gate for this field.
- The backend write boundary validates only `number`, `timezone`, and `tokenList` fields (`src/api/routes/plugins/index.ts:20-60`, `:78-83`). It does not structurally validate booleans, enums, model/destination values, collection contents, or `rolePolicies`; an admin API caller can therefore persist values the UI would never generate. The route explicitly applies the schema-filtered snapshot and reloads it (`:500-518`).
- The People API error branch has no retry callback: `peopleError` renders `ErrorState` without `onRetry` (`web-src/TeamsWorkspace.tsx:515-518`). This is not an autosave failure, but it leaves the people/policy surface without the retry affordance used by the config detail error branch (`:544-548`).
- The generic host plugin detail remains another place where msteams configuration, including `rolePolicies`, can be edited (`web/modules/settings/PluginDetail.tsx:134-152`). Both paths share the same persistence controller, so there is no race between two implementations, but the product should keep one clearly canonical location for role-policy administration.

# Legitimate exceptions

- Linking or replacing an Elowen account is an identity/authorization operation, not ordinary form editing. It correctly uses an immediate PATCH and confirmation for replacement (`web-src/TeamsWorkspace.tsx:155-165`, `:257-264`; `index.mjs:145-161`).
- Force-sign-in/sign-out is an explicit session-security action and correctly uses an immediate POST (`web-src/TeamsWorkspace.tsx:167-176`; `index.mjs:163-171`).
- Removing a role policy changes admission and trusted-room privileges. The shared editor requires consequence-specific confirmation and commits the deletion immediately (`web/modules/settings/PluginConfigEditor.tsx:354-362`, `:413-423`, `:810-817`).
- `appPassword` is a secret. The host never returns its value, exposes only `secretsSet`, and treats an empty incoming secret as unchanged (`src/api/routes/plugins/index.ts:62-105`; `web/modules/settings/PluginConfigEditor.tsx:869-900`). An explicit replacement flow would be defensible for secret material, although the current shared autosave path is internally coherent and safely preserves the existing secret when untouched.
- App-package download is an external file-generation/download action, not editable state (`web-src/TeamsWorkspace.tsx:472-475`; `index.mjs:100-121`).

# Reusable existing pattern

Use the host pattern without a plugin-specific autosave implementation:

- `usePluginConfigDraft` for one shared draft, 900 ms debounce, JSON validation, full-snapshot serialization, secret preservation, immediate `commitValue`, retry, and flush (`web/lib/usePluginConfigDraft.ts:43-112`).
- `useAutoSaveStatus` for debounced persistence with a latest-state queue, stale-write protection, retry, and teardown flush (`web/lib/useAutoSaveStatus.ts:26-105`).
- `AutoSaveStatus` in a stable page/modal header or footer so status remains visible while editors change (`web/components/ui/AutoSaveStatus.tsx:10-26`).
- `commitValue` plus `ConfirmDialog` for destructive or permission-changing collection entries, as already used by role-policy removal (`web/modules/settings/PluginConfigEditor.tsx:354-362`, `:413-423`).
- The host config route's `applyConfigPatch` is the intended single persistence rule for instance and per-account forms, including write-only secret semantics (`src/api/routes/plugins/index.ts:62-87`).

# Tests and gaps

- Plugin-specific UI tests cover policy matching, account option safety, secret-free projections, encoded account paths, and removal of the duplicate role-policy fields from the custom global Settings tab (`tests/msteams-ui.test.ts:45-162`). They do not render the workspace and do not verify autosave timing, status transitions, retry, or unmount flush.
- Plugin tests cover browser-safe people projection and declaration of all manifest-read config keys (`tests/msteams.test.ts:298-319`, `:400-434`). Account-linking tests cover safe status, explicit binding, and sign-out delegation (`tests/msteamsAccountLinking.test.ts:241-252`).
- Host tests cover invalid JSON, write-only secret preservation, immediate commit semantics, serialized full-snapshot writes, and role-policy deletion feedback (`web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105`; `web/tests/modules/settings/PluginConfigEditor.test.tsx:94-122`).
- Missing focused coverage: a rendered msteams workspace autosave test; malformed role-policy/config payload rejection at the route boundary; an empty `roleId` regression test; people-fetch error retry; and end-to-end verification that a saved msteams config is visible after hot reload.
- No test execution was performed in this audit; findings are based on source and existing test inspection.

# Recommended migration notes

- Keep the shared draft and one canonical `rolePolicies` source; do not introduce a second msteams-specific autosave hook.
- Add runtime schema validation for booleans, enums, model/destination/collection values, and the structure of `rolePolicies`; reject blank or malformed role identifiers before persistence. Add a client-side `savable` predicate where the editor can represent an incomplete row.
- Add `onRetry={() => { setPeopleError(null); refetchPeople(); }}`-equivalent behavior to the people load error state, or expose a small local retry callback around the existing fetch effect.
- Decide whether generic Settings → Plugins should remain an administrative fallback for msteams role policies. If it remains, document it as a deliberate secondary surface; otherwise hide or route that field to the People & access workflow rather than creating competing policy entry points.
- Add focused workspace tests for the shared hero status, role-policy debounce/removal paths, account mutation feedback, people retry, and the package-download error experience. Keep identity binding/sign-out immediate and explicit.
