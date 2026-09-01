# Scope

Audited the registry plugin at `/var/www/elowen-plugins/plugins/codebase` and the host surfaces that render and persist its instance-wide `configSchema`:

- Plugin declaration and all 14 configurable fields: `/var/www/elowen-plugins/plugins/codebase/elowen-plugin.json:28-180`.
- Runtime config normalization, SQLite index persistence, scheduled reindexing, and tool behavior: `/var/www/elowen-plugins/plugins/codebase/index.mjs:212-243`, `294-401`, `451-595`, `624-783`.
- Host plugin workspace, shared controls, autosave controller/status, API client, route, and focused tests.

The plugin has no `web` block, `userConfigSchema`, account/user/project panel, or custom browser bundle. Its only web configuration surface is the host admin plugin workspace driven by `configSchema`; the package contains no custom drawer/form implementation.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Plugin catalog → detail entry | `/var/www/elowen/web/modules/settings/PluginsSection.tsx:271-277`; `/var/www/elowen/web/modules/settings/PluginDetail.tsx:161-171` | Admin selects `codebase` from the Plugins settings page. Detail loading has explicit loading/error states and retry. | Compliant |
| Setup tab / required-field checklist | `/var/www/elowen/web/modules/settings/PluginDetail.tsx:59-65`, `114-135`; manifest has no `required` fields (`elowen-plugin.json:28-180`) | No required credentials exist, so the workspace starts on Behavior. The checklist is read-only and does not represent a persistence surface. | N/A |
| Indexing settings card | `/var/www/elowen-plugins/plugins/codebase/elowen-plugin.json:28-69`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:661-708`, `741-742`, `918-946` | `includeGlobs` and `excludeGlobs` use the shared token-list control; `maxFileBytes` and `chunkMaxChars` use number inputs. Every edit updates the shared draft and is PATCHed after a 900 ms debounce. Full snapshots are serialized and flushed on unmount. | Partial |
| Search & behavior settings card | `/var/www/elowen-plugins/plugins/codebase/elowen-plugin.json:71-115`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:661-756` | `topK`, `relevanceFloor`, and `reindexEmbedBudget` auto-save as numbers; `autoReindex` auto-saves as a toggle. No explicit Save button. | Partial |
| Scheduled re-indexing card | `/var/www/elowen-plugins/plugins/codebase/elowen-plugin.json:117-161`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:743-756`, `918-946` | `scheduledReindex` auto-saves immediately through the shared draft; `reindexIntervalMinutes`, `reindexScope`, and `reindexRepos` are conditionally visible and also auto-save. Visibility follows current draft values, so dependent controls appear without a reload. | Partial |
| Scheduled advanced field | `/var/www/elowen-plugins/plugins/codebase/elowen-plugin.json:163-173`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:934-946` | `reindexMaxPassesPerRepo` is moved to the Advanced tab by presentation metadata, but uses the same draft and autosave path. | Partial |
| Embedding model informational section | `/var/www/elowen-plugins/plugins/codebase/elowen-plugin.json:176-180`; `/var/www/elowen/web/modules/settings/PluginDetail.tsx:167-171` | `sec_model` has no value field. It documents that the model is inherited from Settings → Memory; there is no duplicate model selector to persist. | N/A |
| Repository path picker modal | `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:250-273`; `/var/www/elowen/web/components/ui/DirectoryPicker.tsx:11-53`; `/var/www/elowen/web/components/ui/TokenList.tsx:29-109` | The directory browser is read-only. Selecting a folder adds a token to the draft; the parent autosaves the resulting array. Existing paths are preserved and deduplicated. | Compliant |
| Autosave indicator / workspace toolbar | `/var/www/elowen/web/modules/settings/PluginDetail.tsx:102-112`; `/var/www/elowen/web/lib/useAutoSaveStatus.ts:4-105`; `/var/www/elowen/web/components/ui/AutoSaveStatus.tsx:4-27` | Shared `idle`/`saving`/`saved`/`error` states, retry, 900 ms debounce, serialized writes, stale-draft protection, and unmount flush are present. | Partial |
| Config read/write API | `/var/www/elowen/web/lib/elowenClient.ts:133-135`; `/var/www/elowen/src/api/routes/plugins/index.ts:417-435`, `500-518` | `GET /plugins/codebase` returns schema plus defaults and masks secrets; `PATCH /plugins/codebase/config` applies a patch, persists before reload, and returns `202 { pending: true }` when live activation is delayed. | Partial |
| Plugin-owned semantic index | `/var/www/elowen-plugins/plugins/codebase/index.mjs:1-6`, `294-325`, `367-401` | `ctx.dataDir()/index.db` stores chunks, files, and reindex markers. `CodebaseReindex` explicitly spends the embedding provider and writes bounded incremental passes; this is operational data, not a settings form. | Explicit-save justified |
| Capabilities, activity, and data panels | `/var/www/elowen/web/modules/settings/PluginDetail.tsx:141-154`; `/var/www/elowen/web/modules/settings/PluginDataPanel.tsx:24-67` | Capabilities/activity are read-only. Data clear is a destructive action behind confirmation and is not an autosave candidate. | Explicit-save justified |
| Browser UI / drawers / account panels | `/var/www/elowen-plugins/plugins/codebase/elowen-plugin.json:1-181`; host browser route contract `/var/www/elowen/web/app/p/[plugin]/[[...rest]]/page.tsx:25-27` | No `web`, `account`, `user`, `project`, or settings-bundle declarations exist for `codebase`; `/p/codebase` therefore has no plugin-owned UI to audit. | N/A |

# Missing or inconsistent auto-save

1. **The setting draft is auto-saved, but delayed live activation is not surfaced for ordinary saves.** The API explicitly distinguishes durable persistence from runtime activation (`/var/www/elowen/src/api/routes/plugins/index.ts:116-137`, `500-518`; `/var/www/elowen/web/lib/elowenClient.ts:134-135`). However, `usePluginConfigDraft` awaits the save but discards its response (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:72-81`), and `useAutoSaveStatus` maps every resolved save to `saved` (`/var/www/elowen/web/lib/useAutoSaveStatus.ts:51-67`). The toolbar has no pending-activation state (`/var/www/elowen/web/components/ui/AutoSaveStatus.tsx:4-27`). A codebase setting can therefore display “Saved” while the reloaded plugin generation is still using the previous configuration. The dedicated `commitValue` path does return `pending` for role-policy deletion (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:83-101`), but codebase fields never use that path.

2. **Changing indexing settings does not itself rebuild or mark the semantic index as needing a rebuild.** The plugin reads normalized config once during registration (`/var/www/elowen-plugins/plugins/codebase/index.mjs:537-543`), and the changed include/exclude/size/chunk values are only consumed when a later `reindexRepo` pass runs (`index.mjs:342-357`, `367-401`). The UI reports only config-save state, not “index refresh required,” “refresh running,” or “index caught up.” `autoReindex` is deliberately limited to admin sessions and runs fire-and-forget on search (`index.mjs:636-643`); project-scoped searches are instructed to use explicit `CodebaseReindex` (`index.mjs:614-616`). With `autoReindex` disabled, or for a project-scoped caller, a successfully auto-saved indexing change can remain absent from search until a manual or scheduled reindex.

3. **Scheduled behavior has the same activation ambiguity.** The timer is created or removed during plugin generation setup (`index.mjs:483-492`), while settings persistence and registry reload are separate steps (`/var/www/elowen/src/api/routes/plugins/index.ts:515-518`). A delayed reload is a valid persisted state, but the current UI provides no indication that `scheduledReindex`, interval, scope, or pass-limit changes are waiting to become active.

4. **The persistence route does not validate all codebase field types.** `applyConfigPatch` validates only numbers, timezones, and token lists (`/var/www/elowen/src/api/routes/plugins/index.ts:73-84`). `boolean` and `enum` values are accepted without schema-level checks; runtime normalization silently falls back for invalid values (`/var/www/elowen-plugins/plugins/codebase/index.mjs:212-230`). The trusted UI emits valid values, but a direct API caller can receive a successful persistence response for a value the plugin ignores or coerces.

5. **The repository picker has an error message but no loading or retry affordance.** It renders the directory list from `data` and only handles `isError`/empty results (`/var/www/elowen/web/components/ui/DirectoryPicker.tsx:16-32`). This does not lose the draft or bypass autosave, but it makes a slow or transient directory read look blank and requires closing/reopening instead of retrying.

# Legitimate exceptions

- `CodebaseReindex` should remain an explicit operation. It can spend a remote embedding provider, scan many repositories, and run multiple bounded passes; silently starting it after every settings keystroke would be an unsafe cost and lifecycle choice (`index.mjs:339-401`, `691-739`). Automatic refresh is already separately controlled by `autoReindex` and the schedule.
- `Data clear` is destructive and correctly remains an explicit confirmed action (`/var/www/elowen/web/modules/settings/PluginDataPanel.tsx:24-55`; `/var/www/elowen/src/api/routes/plugins/index.ts:485-497`).
- The picker’s “Select folder”/enum modal confirmation commits only the local control value, not a separate server-side Save. The parent draft then autosaves the resulting config; this is appropriate modal interaction, not an explicit-save settings form.
- The embedding model is intentionally not duplicated in this plugin. The manifest documents the single source of truth in Settings → Memory (`elowen-plugin.json:176-180`), and the runtime reads the shared embedding descriptor (`index.mjs:342-355`).

# Reusable existing pattern

The host already provides the correct baseline for ordinary codebase settings:

- `usePluginConfigDraft` seeds once, does not let same-name query refetches overwrite an in-progress draft, serializes full-snapshot PATCHes, validates JSON fields, and flushes before teardown (`/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-112`).
- `useAutoSaveStatus` debounces edits, collapses edits during an in-flight request, exposes retry, and prevents stale responses from overwriting newer snapshots (`/var/www/elowen/web/lib/useAutoSaveStatus.ts:6-105`).
- The shared `TokenList`, `ChoiceField`, and `DirectoryPicker` controls preserve stale values and feed changes through the same draft (`/var/www/elowen/web/components/ui/TokenList.tsx:29-109`; `/var/www/elowen/web/components/ui/ChoiceField.tsx:7-54`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:741-755`).
- The server persists before attempting hot reload and treats post-persistence reload failure as pending rather than as a lost save (`/var/www/elowen/src/api/routes/plugins/index.ts:126-137`, `515-518`).

# Tests and gaps

Existing generic coverage is strong:

- Direct field edits, number canonicalization, sliders, timezone selection, token-list conversion, directory selection, and modal editors are covered in `/var/www/elowen/web/tests/modules/settings/PluginDetail.test.tsx:174-410`.
- Draft invalid-JSON handling, write-only secret omission, serialized full snapshots, immediate commit behavior, and delayed activation for `commitValue` are covered in `/var/www/elowen/web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105`.
- API defaults, masking, number/timezone/token-list validation, persistence ordering, pending reloads, and pre-persistence failures are covered in `/var/www/elowen/tests/api/pluginRoutes.test.ts:103-240`, `339-380`.
- Manifest field vocabulary and `visibleWhen` validation are covered in `/var/www/elowen/tests/plugins/manifest.test.ts:64-212`.

Gaps specific to this plugin/surface:

- No focused `codebase` plugin test file exists in the plugin package; its package contains only the manifest, runtime entry, and two locale files.
- No test asserts the exact `codebase` manifest renders all fourteen fields into the intended Behavior/Advanced cards, or that `scheduledReindex` visibility and `reindexScope=list​ed` interact correctly.
- No test covers an ordinary generic config autosave receiving `{ pending: true }`; the existing pending assertion covers only the special `commitValue` path (`usePluginConfigDraft.test.tsx:71-81`).
- No test covers config edits followed by index freshness/reindex behavior, including indexing-scope changes, disabled auto-reindex, project-scoped search, or scheduled timer activation.
- No API regression test rejects invalid boolean/enum values for a plugin config schema.
- No UI test covers directory-picker loading state or retry behavior.

# Recommended migration notes

- Keep `codebase` on the shared `usePluginConfigDraft` path; do not add a plugin-specific Save button or duplicate draft controller.
- Extend the shared save result/status contract so a normal config save can display a distinct persisted-but-activation-pending state, while retaining the existing visible saving/saved/error+retry behavior.
- Add an explicit freshness signal for indexing-affecting settings (or a clear “reindex required/in progress” status sourced from the existing index/status lifecycle). Do not silently launch a provider-spending full rebuild on every edit; preserve manual, lazy, and scheduled modes.
- Enforce schema-backed boolean and enum validation in the shared `applyConfigPatch` route before persistence; add focused API tests for `autoReindex`, `scheduledReindex`, and `reindexScope`.
- Add a codebase-focused regression suite around manifest field inventory, config autosave with pending activation, and the relationship between saved indexing settings and index freshness.
- Add loading and retry feedback to the shared directory picker without changing its current local-selection-then-parent-autosave contract.
