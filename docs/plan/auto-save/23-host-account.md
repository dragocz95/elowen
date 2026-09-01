# Scope

Audited the host Account route and all editable surfaces under `web/modules/account`, including drawers, toggles, selectors, upload/password flows, plugin-contributed account panels, related `/auth/me/*` persistence routes, CLI preferences that share the same personal settings, and registry plugin personal configuration.

The only host route is `/account` (`web/app/account/page.tsx:1-11`); no `/profile` page route exists. The Account deck is assembled in `web/modules/account/AccountView.tsx:47-51,296-307,336-613`.

## Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Profile name and email | `web/modules/account/AccountView.tsx:120-187,395-407`; `src/api/routes/auth.ts:54-77` | Debounced `useAutoSaveStatus` PATCHes only changed fields to `/auth/me`; visible saving/saved/error/retry state is folded into the profile hero. Baseline and sent-value tracking protect edits across refetches and concurrent field changes. | Compliant |
| Default Elowen AI model | `web/modules/account/AccountView.tsx:189-231,308-315,374-390`; `src/api/routes/auth.ts:144-240` | Immediate PATCH of `model`/`modelProvider`; picker is filtered to allowed models, optimistic selection reverts on failure, and mutation status is exposed through the profile hero. | Compliant |
| Linked chat identities (Discord, Teams, Telegram, WhatsApp) | `web/modules/account/PlatformLinksCard.tsx:22-29,39-145`; `web/modules/account/AccountView.tsx:126-129,199-215,449-479`; `src/api/routes/auth.ts:166-205` | Drawer inputs use debounced autosave and send only changed link keys. Live adapter availability controls which fields appear; conflict errors remain visible through the profile status/retry path. | Compliant |
| UI scale | `web/modules/account/AccountView.tsx:409-422`; `web/lib/useUiScale.tsx:18-65` | Immediate validated localStorage write (`elowen:ui-scale`) and live application to document zoom. This is a per-device preference, not a network transaction. | Compliant |
| Visual effects mode | `web/modules/account/AccountView.tsx:424-443`; `web/lib/useEffects.tsx:64-108` | Immediate validated localStorage write (`elowen:effects`) and live document update. `auto` resolves against OS reduced-motion preference. | Compliant |
| Avatar upload | `web/modules/account/AccountView.tsx:276-280,484-499`; `src/api/routes/auth.ts:284-294`; `tests/api/profile.test.ts:106-170` | Explicit file selection/upload with MIME/size validation and success/error toast. Uploads are a legitimate explicit action; there is no draft to autosave. | Explicit-save justified |
| Password change | `web/modules/account/AccountView.tsx:281-295,510-596`; `src/api/routes/auth.ts:78-90`; `tests/api/profile.test.ts:79-104` | Explicit submit after current-password, length and confirmation checks. Secret/credential change requires deliberate confirmation and server verification. | Explicit-save justified |
| Browser push subscription | `web/modules/account/AccountView.tsx:233-261,598-612` | Toggle immediately calls browser/service-worker permission and subscription APIs; busy state and success/error toasts are shown. Browser permission and external subscription are deliberate side effects, not debounced form edits. | Explicit-save justified |
| CLI runtime preferences: thinking level, vision model, auto-compact, global/per-model thresholds, compact model, fast mode | `web/modules/account/CliSection.tsx:31-157,165-293`; `src/api/routes/auth.ts:144-240` | Seed-once local draft; debounced autosave for the grouped runtime fields and immediate autosave for fast mode. Payloads are scoped to owned fields; aggregated section status reports saving/saved/error/retry. | Partial |
| CLI permission defaults: YOLO and unattended asks | `web/modules/account/CliSection.tsx:78-113,142-157,245-267`; `src/api/routes/auth.ts:255-268` | Separate immediate autosaves to `/auth/me/permissions`, with visible aggregated section status and retry. YOLO activation requires a confirmation dialog before the write. | Compliant |
| Granular bash/tool permission rules | `web/modules/account/PermissionRulesCard.tsx:62-109,111-218`; `src/api/routes/auth.ts:255-268` | Add/change/delete optimistically replaces one scope map immediately through PATCH; failed writes toast and re-seed from query data. No `AutoSaveStatus`, saved state, or retry callback is exposed, and concurrent whole-map writes are not serialized. | Partial |
| Memory automation toggles (auto recall, live recall, auto-save) | `web/modules/account/AccountMemorySection.tsx:23-46,48-71`; `src/api/routes/auth.ts:144-240` | Seed-once draft with debounced autosave and section saving/saved/error/retry status. All three fields are sent as a snapshot. | Partial |
| Personality style and global user instructions | `web/modules/account/PersonalitySection.tsx:23-53,69-116`; `src/api/routes/auth.ts:173-180`; `web/components/ui/AutoSaveStatus.tsx:7-27` | Seed-once style/editor state, debounced autosave, Monaco drawer, and visible modal/section status with retry. Invalid/failed loading does not render an unsavable editor. | Compliant |
| Terminal appearance and CLI chat knobs | `web/modules/account/TerminalSection.tsx:32-73,125-233`; `src/api/routes/auth.ts:242-253` | Seed-once full `TerminalSettings` snapshot with debounced autosave, live preview, and section saving/saved/error/retry status. Server validates/clamps values. | Partial |
| GitHub personal identity connection | `/var/www/elowen-plugins/plugins/github/web-src/GitHubConnectionPanel.tsx:9-74,89-150`; `/var/www/elowen-plugins/plugins/github/elowen-plugin.json:101-112`; `/var/www/elowen-plugins/tests/github-ui.test.tsx:36-113` | Device OAuth flow, polling, cancel, reconnect/replace and disconnect actions use explicit mutations, confirmation for destructive external actions, and localized toasts. The host mounts it through `PluginAccountSection` (`web/modules/account/PluginAccountSection.tsx:21-63`). | Explicit-save justified |
| Personal plugin configuration | Backend: `src/api/routes/plugins/index.ts:358-415`; schema: `/var/www/elowen-plugins/plugins/github/elowen-plugin.json:78-99`; consumer: `/var/www/elowen-plugins/plugins/github/src/service.ts:600-603` | Server provides account-scoped GET/PATCH with masked secrets, schema validation and ownership enforcement, but the host web has no query, mutation, or Account surface for `/plugins/user-config` or `userConfigSchema`. | Missing |
| CLI `/reasoning show` and local CLI preferences | `src/cli/chat/commands.ts:350-357,392-415,483-484`; `src/cli/chat/prefs.ts:6-53`; `src/cli/chat/keybindsEditor.ts:34-80`; `src/cli/chat/pickers.ts:268-287` | Immediate server PATCH for cross-device reasoning visibility with local fallback; theme, mascot and keybind edits write validated local `cli-prefs.json` and apply live. | Compliant |
| CLI setup preferences | `src/cli/setup/steps/preferences.ts:23-79` | One-time interactive setup explicitly PATCHes runtime-context timezone, terminal reasoning visibility and CLI auto-compact. Timezone is instance/plugin configuration rather than an Account form. | N/A |
| `/profile` route | `web/app/account/page.tsx:1-11`; `web/app` route inventory | No separate `/profile` route exists; profile editing is contained in `/account`. | N/A |

## Missing or inconsistent auto-save

- **Personal plugin configuration is not reachable from the host UI.** The daemon deliberately exposes caller-owned plugin values at `/plugins/user-config` and `/plugins/:name/user-config` (`src/api/routes/plugins/index.ts:365-415`), and GitHub declares `mergeMethod` as a personal field (`/var/www/elowen-plugins/plugins/github/elowen-plugin.json:78-99`) and reads it at runtime (`/var/www/elowen-plugins/plugins/github/src/service.ts:600-603`). No host web caller references `user-config` or `userConfigSchema`; the Account deck only loads plugin account panels (`web/modules/account/AccountView.tsx:98-112,351-354`). This leaves a durable personal preference editable only through the API, not through Account.
- **Granular permission rules lack the canonical status contract.** `PermissionRulesCard.persist` calls `save.mutate` directly and only provides a toast/revert path (`web/modules/account/PermissionRulesCard.tsx:96-108`). Its status is not passed to `CliSection`'s aggregated status (`web/modules/account/CliSection.tsx:142-157`), so a failed rule write cannot offer the shared Retry affordance. Rapid changes also send whole scope maps through independent mutations; unlike `useAutoSaveStatus`, writes are not serialized, so an older response can win.
- **Terminal autosave sends a stale full snapshot.** The form intentionally sends all terminal fields (`web/modules/account/TerminalSection.tsx:65-69`). The server merges and validates that snapshot (`src/api/routes/auth.ts:249-253`), but there is no version/field-level conflict handling. A CLI `/reasoning show` write (`src/cli/chat/commands.ts:351-357`) or another Account tab can change `showThoughtsCli` while the web draft is open; a later font/palette save can silently restore the stale value. Seed-once prevents server refetches from clobbering local edits, but does not prevent this cross-writer overwrite.
- **Memory autosave has the same, lower-risk snapshot shape.** `AccountMemorySection` sends all three toggles together (`web/modules/account/AccountMemorySection.tsx:37-42`). Two Account tabs can overwrite an unrelated toggle. There is no other known direct writer for these fields, but the form does not have field-level reconciliation.
- **CLI runtime grouped settings also rely on snapshot ownership.** The grouped PATCH sends vision, compact, reasoning and threshold fields together (`web/modules/account/CliSection.tsx:115-130`). The seed-once and shared serialized hook protect against local in-flight races and query invalidation, but not an independent tab/client changing one of those same fields.
- **Plugin account authentication intentionally does not use autosave status.** GitHub connection, replacement and disconnect are external/credential actions with polling, confirmation and explicit result toasts (`/var/www/elowen-plugins/plugins/github/web-src/GitHubConnectionPanel.tsx:22-74,89-150`); treating them as silent field autosaves would be misleading.

## Legitimate exceptions

- Password changes are secret credential operations requiring current-password verification and an explicit submit.
- Avatar selection is an upload, not a draft form.
- Push enable/disable invokes browser permission and service-worker subscription state immediately.
- GitHub device authorization, identity replacement and disconnect affect an external account and use explicit actions/confirmation.
- CLI setup is a one-time interactive bootstrap flow; its timezone write is instance-level configuration, not a personal Account form.

## Reusable existing pattern

- `web/lib/useAutoSaveStatus.ts:6-105` is the canonical controller: seed gating, bounded debounce, serialized writes, stale in-flight protection, teardown flush and retry.
- `web/components/ui/AutoSaveStatus.tsx:7-27` provides the shared saving/saved/error+retry presentation.
- `web/lib/usePluginConfigDraft.ts:37-112` already supports schema validation, full-snapshot serialization, secret masking semantics, immediate confirmed commits and an overridable per-account save target. It is currently used by instance plugin settings (`web/modules/settings/PluginDetail.tsx:41-65`), not by Account.
- The existing plugin editor (`web/modules/settings/PluginConfigEditor.tsx:632-1014`) already renders the schema field vocabulary, including enum, secret, text, JSON and structured-list controls. It can be reused for personal plugin config once a user-config query/mutation and Account host surface exist.

## Tests and gaps

Existing focused coverage includes:

- Profile/link concurrency and refetch protection: `web/tests/modules/account/AccountView.test.tsx:154-240,309-423`.
- Personality autosave and error gating: `web/tests/modules/account/PersonalitySection.test.tsx:36-85`.
- Terminal autosave, seeded CLI knobs and split-record persistence: `web/tests/modules/account/TerminalSection.test.tsx:31-97,109-158`.
- CLI permission-default autosave: `web/tests/modules/account/CliSectionYolo.test.tsx:49-80`.
- Memory autosave: `web/tests/modules/account/AccountMemorySection.test.tsx:27-63`.
- Permission rule optimistic rollback and map ordering: `web/tests/modules/account/PermissionRulesCard.test.tsx:42-147`.
- Shared autosave lifecycle/race behavior: `web/tests/lib/useAutoSaveStatus.test.tsx:6-102`.
- Backend personal plugin config isolation, masked secrets, validation and grants: `tests/api/pluginUserConfig.test.ts:85-219`.

Gaps:

- No host web test covers rendering or saving `/plugins/user-config`; no Account query/mutation exists to test.
- No PermissionRulesCard test asserts visible saving/saved/error/retry state or concurrent write serialization.
- No frontend concurrency test covers terminal or memory full-snapshot overwrites from another tab/CLI.
- Backend profile/avatar/password coverage exists, but AccountView has no focused tests for avatar upload, push permission failure, or password validation/error presentation.

## Recommended migration notes

- Add host client/query/mutation support for `/plugins/user-config` and render each returned schema as an Account personal-plugin section. Use `usePluginConfigDraft(name, detail, { save })` plus `PluginConfigEditor`, preserving write-only secrets and the existing `AutoSaveStatus`/retry contract.
- Route personal-plugin settings to the Account deck independently of admin-only instance plugin detail; keep plugin grant/enabled filtering server-authoritative.
- Give permission rules a shared serialized autosave controller or equivalent mutation queue, and report its status through `CliSection` so every editable permission surface has the same retryable indicator.
- Prefer field-level PATCHes or server-side revision/merge semantics for terminal, memory and grouped CLI settings so a save from one client cannot restore stale sibling values. At minimum, add regression tests for a CLI/second-tab write during an Account autosave.
- Keep OAuth, uploads, browser permission changes and password changes explicit; do not force them into debounced autosave merely to make the UI uniform.
