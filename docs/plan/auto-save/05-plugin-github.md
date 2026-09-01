# Scope

Audited `/var/www/elowen-plugins/plugins/github` source, manifest, browser bundle sources and generated bundle, plus the host surfaces that mount registry-plugin UI and persist plugin configuration. Scope includes:

- Account linked-account drawer row and closed-summary chip.
- GitHub CLI device authentication, reconnect and identity replacement.
- Project repository mapping and remote detection.
- Pull-request list/detail, review, merge, publish and create-PR flows.
- Per-account `mergeMethod` configuration and all GitHub persistence/confirmation APIs.
- Tool callers for outward actions, because they share the same service and confirmation boundary.

Auto-save means that validated settings edits persist through the shared debounced mechanism, with visible saving/saved/error-and-retry state and stale-write protection. External GitHub mutations and credential authorization are assessed as explicit-action surfaces rather than ordinary settings.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Account linked-account row and summary chip | `elowen-plugin.json:101-119`; `web-src/GitHubConnectionPanel.tsx:121-150,158-164`; host `web/modules/account/PlatformLinksCard.tsx:105-140` | The plugin is mounted as the host's shared `LinkedAccountRow`; the resolved GitHub login is read from `GET /plugins/github/api/status`. Account identity/token changes happen through device authorization or confirmed disconnect/replace actions, not field editing. | Explicit-save justified |
| Device-flow start, resume, polling and cancel | `web-src/GitHubConnectionPanel.tsx:22-40,58-84,101-118`; `src/api.ts:29-38`; `src/service.ts:100-164`; `src/store.ts:79-96,145-194`; `src/githubAuth.ts:116-145,241-257` | A pending flow is inserted before CLI work starts, stores its directory/prompt/status, polls every 2 seconds, and is rehydrated from `status.flow` after remount. Cancellation/expiry and cleanup are persisted. | Partial |
| Per-account default merge-method config | `elowen-plugin.json:78-99`; host `src/api/routes/plugins/index.ts:392-415`; host `src/store/userPluginConfigStore.ts:7-12,29-40`; `src/plugins/manifest.ts:158-164`; `src/service.ts:600-603`; `web-src/GitHubProjectPanel.tsx:41-43,150` | The backend has an account-scoped atomic JSON store and `PATCH /plugins/:name/user-config`, but the GitHub plugin has no browser config form/query/mutation for it. The host admin editor is driven by `configSchema` (`web/modules/settings/PluginDetail.tsx:58-64`; `web/modules/settings/PluginConfigEditor.tsx:632-643`), while GitHub declares `userConfigSchema`. The project merge modal locally defaults to `squash` and always sends an explicit method, so a stored `mergeMethod` is bypassed by the web UI. | Missing |
| Project repository mapping | `web-src/GitHubProjectPanel.tsx:15-24,104-146,156-165`; `src/api.ts:45-51`; `src/service.ts:361-376`; `src/store.ts:214-253` | Four repository identity fields are held in local modal state and submitted as one `POST /repositories/map`. The service validates project access, resolves both repositories through GitHub, checks pull/push permissions, then writes one verified mapping row. Errors leave the modal open but only produce a toast. | Explicit-save justified |
| Remote detection API and displayed suggestions | `src/api.ts:41-43`; `src/service.ts:347-358`; `web-src/GitHubProjectPanel.tsx:18-23,104-114,143` | `GET /repositories` returns local remote snapshots and `suggestedRepositories`; the UI renders those suggestions when opening the map form. The stronger `POST /repositories/detect` endpoint, which verifies candidates against GitHub, has no browser caller or Detect button despite the manifest string at `elowen-plugin.json:158`. | Missing |
| Pull-request list, detail, checks and changed files | `web-src/GitHubProjectPanel.tsx:25-55,117-150`; `src/api.ts:53-58`; `src/service.ts:392-411` | Read-only React Query fetches. Selection is local state; no persistence is expected. Loading and retry states exist for status, repositories, pulls and pull detail, but checks do not render a dedicated error state. | N/A |
| Publish branch action | `web-src/GitHubProjectPanel.tsx:70-90,118`; `src/api.ts:59-66,69-94`; `src/service.ts:450-464,494-521`; `src/execution.ts:111-183` | The user chooses a conversation, requests a server preview, then confirms a one-use token. The server rechecks workspace, head, mapping and branch invariants and uses a one-shot credential broker with no force-push. | Explicit-save justified |
| Create pull request action | `web-src/GitHubProjectPanel.tsx:40-41,118,148`; `src/service.ts:450-464,494-521`; `src/githubClient.ts:95-97` | Title/body/base are a local transactional draft. Preview and confirmation publish the branch and create or return an existing matching PR. No ordinary auto-save is appropriate for an external mutation. | Explicit-save justified |
| Submit review action | `web-src/GitHubProjectPanel.tsx:42,150`; `src/service.ts:466-470,523-529`; `src/githubClient.ts:100-107` | Review event/body remain local until the user explicitly previews and confirms the external review. Server checks PR head/state/draft before submission. | Explicit-save justified |
| Merge pull request action | `web-src/GitHubProjectPanel.tsx:43,150`; `src/service.ts:471-472,523-542`; `src/githubClient.ts:109-110` | Merge method is local state and confirmation is required. Server rechecks head SHA, open/non-draft state, successful checks, review state and repository merge-method policy. | Explicit-save justified |
| Disconnect and replace GitHub identity | `web-src/GitHubConnectionPanel.tsx:42-50,91-99,132-150`; `src/service.ts:434-443,475-485`; `src/store.ts:130-143` | Both use persisted preview records and explicit confirmation. Disconnect deletes secrets, deactivates mappings and removes account state; replacement consumes a confirmation before starting a new device flow. | Explicit-save justified |
| Shared mutation/confirmation API and tool callers | `src/store.ts:272-299`; `src/service.ts:413-431`; `src/tools.ts:10-20,54-76`; `src/api.ts:59-72` | Preview records store hashed random tokens, target and expected state; consumption is atomic, single-use and five-minute bounded. Browser and interactive tools use the same service, while unattended tool mutation is denied. | Compliant |

# Missing or inconsistent auto-save

- **The only declared GitHub setting is not reachable from the web UI.** `mergeMethod` is declared as `userConfigSchema` (`elowen-plugin.json:78-99`) and is read at execution time through `ctx.userConfig()` (`src/service.ts:600-603`). The host does expose the account-scoped write route (`src/api/routes/plugins/index.ts:392-415`), but its browser query/mutation surface only covers instance `configSchema` (`web/modules/settings/PluginDetail.tsx:58-64`; `web/lib/queries.ts:250-256`; `web/lib/mutations.ts:283-288`). No GitHub browser code calls `/plugins/github/user-config`.
- **The web merge form bypasses the stored preference.** `GitHubProjectPanel` initializes `mergeMethod` to `'squash'` (`web-src/GitHubProjectPanel.tsx:41-43`) and always includes `method` in the merge preview (`:150`). This prevents the service fallback to `ctx.userConfig().mergeMethod` from being used for web merges. Tools that omit `method` do use the stored preference through `src/service.ts:536-602`, creating inconsistent behavior between web and tool callers.
- **Mapping has explicit-save semantics but lacks save-state UX.** The multi-field mapping must be validated against GitHub and committed atomically, so an explicit Save is defensible. However, `saveMap` only shows a success toast or error toast (`web-src/GitHubProjectPanel.tsx:64-69`); the Save button is not disabled while pending, there is no visible Saving state, and there is no dedicated Retry affordance.
- **Confirmation failures are not retry-safe.** `confirm()` consumes the confirmation before executing the action (`src/service.ts:424-427`; `src/store.ts:282-299`). Browser `onError` handlers leave the dialog or toast in place but do not obtain a new preview (`web-src/GitHubProjectPanel.tsx:75-90`; `web-src/GitHubConnectionPanel.tsx:47-50`). A request that reaches the server, consumes the token, and then fails leaves the visible Confirm action unusable because a second attempt returns `confirmation_used`.
- **Replace-identity failure loses the only visible recovery affordance.** The account panel clears `pending` before the `auth/start` mutation resolves (`web-src/GitHubConnectionPanel.tsx:91-99`), so a transient failure after confirmation requires starting the preview flow again without a retry control.
- **A persisted device flow can be invisible during the promptless window.** The backend exposes `authInProgress` and stores a pending flow before the CLI prompt is available (`src/service.ts:69-80,100-134`), but the panel only restores a flow when `verificationUrl` and `userCode` are already present (`web-src/GitHubConnectionPanel.tsx:58-63`). After a refresh in that window, the user sees no cancel/waiting control and a new start receives `auth_in_progress`.
- **Device-flow polling has incomplete error presentation.** The panel handles `404/flow_not_found` specially (`web-src/GitHubConnectionPanel.tsx:76-84`), but other polling failures do not render an error state or retry action; the waiting screen can remain displayed while polling continues.
- **The verified detect endpoint is orphaned from the UI.** `POST /repositories/detect` performs GitHub verification (`src/api.ts:41-43`; `src/service.ts:347-358`), but the panel only calls `/repositories` (`web-src/GitHubProjectPanel.tsx:18-23`). The displayed detection is therefore local parsing/suggestion data rather than the available verified-detection flow.
- **Mapping provenance can be overwritten by a later save.** `mappingFrom()` takes `baseRemote` and `pushRemote` from current detected remotes, not from the stored mapping (`web-src/GitHubProjectPanel.tsx:156-165`). Reopening an existing mapping after remotes change and saving again can replace or clear those metadata fields.
- **Disconnect's GitHub-side revocation result is dropped.** The server explicitly says GitHub authorization is not revoked automatically and returns `revokeUrl` (`src/service.ts:438,475-480`), but the account panel's success handler ignores the result and only shows a generic completion toast (`web-src/GitHubConnectionPanel.tsx:47-50`).

# Legitimate exceptions

- Device authorization, reconnect and identity replacement are credential/consent flows and must remain explicit. The CLI token is stored in the plugin secret bag only after profile verification (`src/service.ts:276-305`), and the device flow uses a bounded ten-minute TTL (`src/githubAuth.ts:12,116-137`).
- Repository mapping is a multi-field association that requires external repository lookup and permission validation before persistence (`src/service.ts:361-376`). Auto-saving each keystroke would cause unnecessary GitHub requests and could commit a half-edited base/push pair.
- Publish, create PR, review and merge are outward GitHub mutations. Explicit preview/confirmation is appropriate; merge additionally requires exact head/check/review invariants (`src/service.ts:523-542`).
- Disconnect and identity replacement change credentials and account ownership state. Their persisted confirmation and stale-account checks are justified (`src/service.ts:434-443,475-485`).
- Pull-request browsing, checks, changed files, connection tests and repository reads are read-only or diagnostic and do not need auto-save.

# Reusable existing pattern

The host already provides the required pattern for ordinary schema settings:

- `usePluginConfigDraft` debounces at 900 ms, gates the initial seed, serializes full-snapshot writes, flushes on unmount and exposes `status`, `retry` and `flush` (`web/lib/usePluginConfigDraft.ts:37-112`).
- `useAutoSaveStatus` provides `idle`, `saving`, `saved` and `error`, serializes queued edits, flushes pending edits on teardown and supports retry (`web/lib/useAutoSaveStatus.ts:6-105`).
- `AutoSaveStatus` renders accessible Saving/Saved/error-and-Retry feedback (`web/components/ui/AutoSaveStatus.tsx:7-26`).
- The generic editor already supports an alternate save callback specifically for per-account forms (`web/modules/settings/PluginConfigEditor.tsx:639-648`; `web/lib/usePluginConfigDraft.ts:40-49`).
- Host tests cover invalid values, write-only secrets, immediate confirmed commits, delayed activation, serialized snapshots and final saved state (`web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105`).

This pattern is suitable for `mergeMethod` once a GitHub account settings surface supplies the account-scoped detail and a save callback to `/plugins/github/user-config`. It should not be applied to the external GitHub action forms.

# Tests and gaps

- No plugin-local test files are present under `/var/www/elowen-plugins/plugins/github`; the registry plugin's device flow, store, API routes, mapping validation, confirmation consumption and browser panels therefore lack focused regression coverage in the authoritative plugin repository.
- Host generic autosave behavior is covered by `web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105`, and host plugin config layout is covered by `web/tests/modules/settings/PluginConfigEditor.test.tsx:81-100`, but neither exercises GitHub's `userConfigSchema` or `/plugins/:name/user-config` integration.
- There is no browser test proving that a stored GitHub `mergeMethod` is loaded and honored by the merge modal; current source demonstrates the mismatch at `web-src/GitHubProjectPanel.tsx:41-43,150`.
- There is no focused test for a confirmation token consumed before an execution/network failure, for the replace-identity error path, or for device-flow restoration before prompt data exists.
- There is no focused UI test for the orphaned `/repositories/detect` route, mapping save pending/error/retry state, ignored disconnect `revokeUrl`, or cross-PR review-form draft carry-over.

# Recommended migration notes

- Treat `mergeMethod` as the highest-priority persistence inconsistency: expose GitHub's existing account-scoped schema through the host's shared draft/autosave primitives, then hydrate the project merge selector from that value while preserving an explicit per-action override.
- Keep mapping as an explicit validated commit, but add the shared mutation pending state and a retry path; preserve stored `baseRemote`/`pushRemote` when the current detection no longer supplies them.
- Keep outward actions explicit and confirmation-gated. Make confirmation execution retry-safe by re-previewing after a consumed-token failure or by returning a server-supported fresh preview contract; do not merely re-submit the consumed token.
- Make the device-flow status model visible during the persisted promptless phase, with a cancel path and a bounded retry/error state for non-404 polling failures.
- Either wire the verified Detect endpoint into the mapping modal or remove the unused route/string contract; retaining two detection semantics without an affordance is misleading.
- Surface the disconnect `revokeUrl` after local disconnect, or change the confirmation copy to make the required GitHub-side revocation step unambiguous.
