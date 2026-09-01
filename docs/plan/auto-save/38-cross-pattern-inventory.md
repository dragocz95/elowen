# Scope

Inventory of persistence UX patterns in `/var/www/elowen/web` and every existing `*/web-src` bundle under `/var/www/elowen-plugins/plugins`. The audit distinguishes durable server persistence from local UI preference persistence and from one-shot operational/external actions. It identifies duplicated patterns, the strongest canonical candidate, and constraints required before converging on one source of truth.

## Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Shared auto-save controller/status | `/var/www/elowen/web/lib/useAutoSaveStatus.ts:4-105`; `/var/www/elowen/web/components/ui/AutoSaveStatus.tsx:7-29` | Debounced draft persistence; seed gating; separate validity gate; serialized follow-up save; flush on close/unmount; `saving`/`saved`/`error` with Retry. | Compliant |
| Plugin config workspace (host + bundles) | `/var/www/elowen/web/lib/usePluginConfigDraft.ts:37-112`; `/var/www/elowen/web/modules/settings/PluginDetail.tsx:58-110`; `/var/www/elowen/web/modules/settings/PluginConfigEditor.tsx:632-715` | One schema-driven draft shared by inline controls and modal editors; 900 ms debounce; JSON validation; full-snapshot serialization; secrets are not re-sent; shared status in toolbar. | Compliant |
| Core Brain runtime/dashboard/memory settings | `/var/www/elowen/web/modules/settings/BrainRuntimeSection.tsx:30-156`; `/var/www/elowen/web/modules/settings/DashboardSection.tsx:45-85`; `/var/www/elowen/web/modules/settings/MemorySection.tsx:58-103` | Independent draft groups use the shared auto-save hook; immediate or debounced timing by field; aggregated section feedback; server-clamped values are compared with the response. | Compliant |
| Core Account profile and linked values | `/var/www/elowen/web/modules/account/AccountView.tsx:141-231`, `:308-325` | Field-level dirty baselines prevent refetch clobbering; changed-only PATCH; model selection is immediate optimistic mutation; profile/link saves use shared auto-save and aggregate into the hero. | Partial (model picker lacks the shared status lifecycle) |
| Account CLI/personality/terminal/memory | `/var/www/elowen/web/modules/account/CliSection.tsx:43-157`; `/var/www/elowen/web/modules/account/PersonalitySection.tsx:30-53`; `/var/www/elowen/web/modules/account/TerminalSection.tsx:53-70`; `/var/www/elowen/web/modules/account/AccountMemorySection.tsx:27-43` | Seed-once drafts; shared auto-save; `delay: 0` for permission/fast toggles; section status is reported to the Account hero. | Compliant |
| Account permission rules | `/var/www/elowen/web/modules/account/PermissionRulesCard.tsx:62-109` | Optimistic whole-map replacement on every rule edit; toast and local rollback on failure; no `saving/saved/retry` status and no serialization for rapid edits. | Partial |
| Navigation customization | `/var/www/elowen/web/components/shell/NavCustomization.tsx:40-50` | Optimistic local cache update followed by immediate PATCH; query invalidation on error; no visible save state or retry affordance. | Partial |
| Core model catalog/forms | `/var/www/elowen/web/app/settings/page.tsx:221-288`, `:312-353`; `/var/www/elowen/web/modules/settings/ModelModal.tsx:34-109`; `/var/www/elowen/web/modules/settings/ModelNoteModal.tsx:11-45`; `/var/www/elowen/web/modules/settings/ContextWindowModal.tsx:12-53` | Catalog edits are applied to local state and then auto-saved; note/context modals use shared auto-save; add/edit model modal remains explicit Save. | Partial |
| Brain provider credentials/models | `/var/www/elowen/web/modules/settings/BrainProvidersSection.tsx:381-487`; `/var/www/elowen/web/modules/settings/ProviderCompatibilityModal.tsx` | Whole provider list is explicitly committed from a modal; API keys, probing, temperature normalization and provider identity are validated before mutation. | Explicit-save justified |
| Tool-loading policy | `/var/www/elowen/web/modules/settings/ToolDeferralModal.tsx:67-86`, `:146-161`, `:248-251` | Large nested policy is held locally and committed once with explicit Save; inline error only, no shared save status. | Explicit-save justified |
| Generic multi-select picker | `/var/www/elowen/web/components/ui/ManageSelectionModal.tsx:280-303` | Local selection draft with Cancel/Save changes; caller receives the complete set and usually diffs it into individual mutations. | Explicit-save justified |
| Memory detail | `/var/www/elowen/web/modules/memory/MemoryDetail.tsx:57-103`, `:118-167` | Shared auto-save for body/metadata/category; empty body is held; Done flushes pending edits; delete/restore remain explicit actions. | Compliant |
| Markdown asset editor (skills/sub-agents) | `/var/www/elowen/web/modules/settings/MarkdownAssetEditor.tsx:50-116`, `:170-193`, `:357-395`; `/var/www/elowen-plugins/plugins/skills/web-src/SkillsSettings.tsx:73-201` | Full create/edit form keeps a local draft until explicit Save; Cancel closes and drops it; create/update uses toast callbacks, not shared save status. | Missing |
| Cron jobs | `/var/www/elowen-plugins/plugins/cronjob/web-src/JobsSettings.tsx:246-321`, `:323-365`, `:447-450`; `/var/www/elowen-plugins/plugins/cronjob/web-src/runtime.ts:60-66` | Strong plugin implementation: per-row draft, 900 ms shared auto-save, validity gate, server-copy adoption only when clean, status/Retry stays on the row after drawer close, deletion waits for in-flight PUT. | Compliant |
| Teams people access and plugin settings | `/var/www/elowen-plugins/plugins/msteams/web-src/TeamsWorkspace.tsx:269-307`, `:409-469`; `:521-532` | Role-policy edits write into the shared plugin config draft and use the host auto-save/status; identity bind/sign-out are immediate account actions. | Compliant for policy config; N/A for identity actions |
| MCP server manager | `/var/www/elowen-plugins/plugins/mcp/web-src/McpServersPage.tsx:169-185`, `:292-304`, `:362-395` | Local multi-field drawer draft; explicit Save; scope transfer is a separate first step; loading/error text and daemon refusal are shown, but no shared auto-save. | Explicit-save justified |
| Sites visibility and guests | `/var/www/elowen-plugins/plugins/sites/web-src/SiteDetail.tsx:62-94`, `:175-203`, `:285-302` | Visibility selection mutates immediately, with public confirmation; guest picker has local selection plus explicit Save; destructive/release/runtime actions are explicit mutations. | Partial / Explicit-save justified by action |
| GitHub repository mapping and external workflow | `/var/www/elowen-plugins/plugins/github/web-src/GitHubProjectPanel.tsx:36-78`, `:107-152`; `/var/www/elowen-plugins/plugins/github/web-src/GitHubConnectionPanel.tsx:22-50`, `:121-150` | Mapping modal has explicit Save; publish/create/review/merge and identity replacement use preview → confirmation token → external mutation; device auth polls until terminal state. | Explicit-save justified |
| OneDrive project mirrors/conflicts | `/var/www/elowen-plugins/plugins/onedrive/web-src/OneDriveProjectPanel.tsx:250-293`, `:405-471` | Connect, pause/resume, sync, conflict resolution and disconnect are immediate operational actions, often confirmation-gated; folder choice is local until Connect. | N/A (actions, not editable settings) |
| Project code editor | `/var/www/elowen-plugins/plugins/editor/web-src/editor/ProjectEditor.tsx:71-81`, `:183-205`, `:365-380`; `/var/www/elowen-plugins/plugins/editor/web-src/editor/EditorPane.tsx:11-47` | Per-file local draft with dirty marker; deliberate Cmd/Ctrl+S or toolbar Save; same-file writes serialize in the host mutation; success retires only the sent generation. | Explicit-save justified |
| Editor uploads and file-tree mutations | `/var/www/elowen-plugins/plugins/editor/web-src/editor/upload.ts:11-41`; `/var/www/elowen-plugins/plugins/editor/web-src/editor/ProjectEditor.tsx:271-293`, `:235-260` | Explicit, sequential chunk upload and explicit create/rename/copy/delete actions with toast outcomes. | N/A (actions/transfer) |
| WhatsApp pairing | `/var/www/elowen-plugins/plugins/whatsapp/web-src/PairingSettings.tsx:9-29`, `:57-126` | Pair/unpair are lifecycle actions; QR/code modal polls status and refreshes after close; failures are represented by status/error, not a settings draft. | N/A |
| Usage/statistics filters | `/var/www/elowen-plugins/plugins/stats/web-src/StatsView.tsx:111-129` | Date range is validated and persisted in localStorage; search/filter/page/selection are transient. | N/A (local UI preference) |
| Sites filters/navigation | `/var/www/elowen-plugins/plugins/sites/web-src/SitesPage.tsx:154-175` | Section, visibility and status are validated localStorage preferences; search and selected drawer are transient. | N/A (local UI preference) |
| Editor height/preferences | `/var/www/elowen-plugins/plugins/editor/web-src/editor/ProjectEditor.tsx:35-41`, `:87-115` | Device-local localStorage persistence with normalization; unrelated to server settings auto-save. | N/A (local UI preference) |

## Missing or inconsistent auto-save

### Distinct patterns and duplicates

1. **Canonical debounced auto-save** — already centralized in `useAutoSaveStatus`, with `AutoSaveStatus` as the visual contract. The hook is not merely a delay helper: it owns seed suppression, validity gating, serialized latest-state writes, flush, retry, and lifecycle safety (`useAutoSaveStatus.ts:6-24`, `:45-105`).
2. **Resource-specific draft controller** — `usePluginConfigDraft` correctly adds full-snapshot serialization, schema-aware JSON validation, secret preservation, immediate confirmed commits, and refetch-safe seeding (`usePluginConfigDraft.ts:37-112`). This is the right second layer for resources whose API accepts snapshots.
3. **Hand-rolled explicit Save forms** — repeated in `MarkdownAssetEditor`, MCP, provider/model modals, tool-loading policy, GitHub mapping and picker dialogs. These all duplicate local draft state, validation, pending state, close semantics and error presentation, but differ in whether closing loses edits.
4. **Immediate optimistic mutation controls** — repeated in permission rules, navigation customization, account model selection, site visibility, skill invocation toggle and many project/user assignments. Some are appropriate for atomic toggles, but most do not expose a uniform saving/error/retry lifecycle and several rely only on a toast.
5. **Action workflows** — preview/confirm external GitHub operations, public-site confirmation, OneDrive deletion confirmation, pairing/device-auth polling, and editor file-transfer operations. These are not interchangeable with editable-setting auto-save.
6. **Local UI persistence** — `usePersistentState` is already a separate source of truth for last-section/filter/device preferences, validating stored values on hydration (`/var/www/elowen/web/lib/usePersistentState.ts:4-34`). It must not be merged with server auto-save.

### Main gaps

- `MarkdownAssetEditor` is the clearest missing server auto-save surface. Its contract explicitly requires `onSave`, `saving`, Cancel and a close that drops the draft (`MarkdownAssetEditor.tsx:104-116`, `:170-181`, `:388-395`). It overlaps materially with the schema-driven plugin config editor but has no debounce, flush, status or retry.
- MCP and GitHub mapping use their own `saving`/error handling instead of the shared status vocabulary. MCP's scope transfer makes the operation multi-step (`McpServersPage.tsx:366-383`), so it should not be blindly converted to per-keystroke writes; the inconsistency is the lack of a common explicit-commit controller/status, not necessarily the presence of Save.
- Permission rules and navigation customization optimistically mutate without a visible status. `PermissionRulesCard` rolls back from query data on failure (`PermissionRulesCard.tsx:97-108`), while navigation invalidates on error (`NavCustomization.tsx:47-50`); neither offers the user an actionable Retry state.
- Account's Elowen model picker mutates immediately and only reverts on error (`AccountView.tsx:217-230`), unlike neighboring autosaved fields. This is a smaller UX inconsistency, though immediate persistence is reasonable for a single selection.
- `ToolDeferralModal` has a legitimate batch-save reason but duplicates pending/error/close logic rather than using a shared explicit-commit status primitive (`ToolDeferralModal.tsx:146-161`, `:246-251`).
- `AccountMemorySection` reports auto-save status to the parent but renders no local indicator (`AccountMemorySection.tsx:37-43`); this is acceptable only because `AccountView` deliberately renders the aggregate in its hero (`AccountView.tsx:308-325`). Any reuse outside that parent would become silent.

## Legitimate exceptions

- **Secrets and credentials:** provider API keys, passwords, OAuth/device authorization and account linking require explicit, deliberate actions and must never be treated as ordinary text drafts. Provider save validates and conditionally includes the key (`BrainProvidersSection.tsx:450-484`); password submission is explicit (`AccountView.tsx:281-294`).
- **Destructive or authorization-changing operations:** delete, restore, public visibility, disconnect, unpair, permission changes with semantic risk, and OneDrive conflict/deletion confirmations need an explicit action or confirmation. Auto-save may still apply to a non-destructive draft surrounding the action, but not to the destructive step itself.
- **Multi-step or atomic forms:** MCP scope transfer plus PATCH, tool-loading policy, guest-set replacement and provider-list replacement can involve several dependent writes or a complete set replacement. Preserve a local draft and commit atomically/sequentially rather than issuing a request for every keystroke.
- **External side effects:** GitHub publish/create/review/merge, site publish/runtime actions, OneDrive sync, WhatsApp pairing and editor uploads are operations, not ordinary settings. Preview/confirmation, progress, polling or per-operation error is the correct UX.
- **Code and file checkpoints:** the project editor intentionally exposes Cmd/Ctrl+S and a dirty marker (`ProjectEditor.tsx:183-205`, `:365-380`). Auto-saving source files would change the deliberate checkpoint and conflict model; retain explicit save unless product policy explicitly changes.
- **Local-only preferences:** filters, tabs, layout, editor size and appearance preferences belong in localStorage through validated helpers, not the daemon. The host/plugin runtime exposes the same `usePersistentState` to bundles (`/var/www/elowen/web/lib/pluginUi.tsx:338-358`).

## Reusable existing pattern

The strongest canonical candidate is the existing **host-owned `useAutoSaveStatus` + `AutoSaveStatus` pair**, with `usePluginConfigDraft` as the resource-level adapter for schema/full-snapshot records.

Why it is strongest:

- It is already used by core settings, account settings, memory detail, model notes/context, plugin config and cron jobs.
- It has the most complete race/lifecycle contract: no seed write, validation separate from readiness, bounded debounce or immediate mode, serialized follow-up writes, unmount flush, retry, and stale-status protection (`useAutoSaveStatus.ts:6-24`, `:45-105`).
- The cron row demonstrates the best end-user placement: saving state and Retry stay attached to the persisted row even after its drawer closes, and the row adopts server changes only when clean (`JobsSettings.tsx:246-321`, `:323-331`, `:447-450`).
- The plugin boundary already publishes the same hook, status component and config draft through `ElowenUiRuntime` rather than allowing bundles to import host internals (`pluginUi.tsx:294-358`). This makes one behavior possible without a second implementation in plugin source.

The canonical contract should therefore be: **draft state owned by the surface, persistence semantics owned by the shared controller, resource-specific validation/serialization owned by an adapter, and status rendered by the shared status component at the nearest durable surface.**

## Tests and gaps

Existing coverage is unusually strong for the canonical controller:

- `web/tests/lib/useAutoSaveStatus.test.tsx:6-102` covers seed suppression, debounce, status transitions, retry, unmount flush, in-flight unmount completion, React Activity hide/show lifecycle and stale response ordering.
- `web/tests/modules/settings/usePluginConfigDraft.test.tsx:31-105` covers invalid JSON, untouched secrets, confirmed immediate commits, delayed activation and serialized full snapshots.
- `web/tests/lib/writeProjectFile.test.tsx:43-98` covers per-file write serialization, parallelism across different files and recovery after a failed write.
- `web/tests/modules/settings/PluginDetail.test.tsx:199-326` covers direct config auto-save, canonical numeric values, sliders, timezone modal commit and stale-value preservation.
- `web/tests/pluginUi/mcpServersPage.test.tsx:197-263` covers explicit MCP transfer ordering and daemon refusal text.

Gaps relevant to convergence:

- No focused regression test establishes the intended save/status contract for `MarkdownAssetEditor` or proves draft behavior after closing its drawer.
- No shared tests cover an explicit multi-step commit controller (transfer + PATCH, batch replacement) with a persistent error/retry state.
- Permission rules and navigation customization lack tests for rapid consecutive writes, error recovery and user-visible retry semantics.
- Account model selection has rollback coverage indirectly but no parity test with the aggregate `AutoSaveStatus` UX.
- Plugin-side bundles have runtime-contract tests for some surfaces, but no cross-bundle assertion that every editable server-backed form either uses the shared auto-save contract or declares an explicit-save exception.
- Several localStorage preferences are tested individually; there is no inventory guard preventing a server-backed setting from accidentally becoming a second local-only source of truth.

## Recommended migration notes

- Keep `useAutoSaveStatus` as the only debounce/race/lifecycle implementation. Do not introduce per-plugin debounce helpers or ad-hoc `saving` booleans for ordinary editable settings.
- Keep `AutoSaveStatus` as the only generic status vocabulary and visual contract: idle, saving, saved, error and Retry. Aggregate multiple controllers with `combineSaveFeedback` where a section has independent API resources.
- Add a shared **explicit commit status/controller** for justified batch forms, so explicit Save remains consistent without pretending those forms are autosave-safe. It should preserve local Cancel, validate before commit, expose pending/error/retry, and support ordered multi-step writes with a refresh after partial success.
- Treat `usePluginConfigDraft` as the canonical adapter for schema-driven plugin records. Avoid a second skill/sub-agent editor persistence model where the resource can safely use the same draft/status/flush semantics.
- For every migration, define the server source of truth and the draft identity first: resource id plus ownership/scope, not display name alone. The MCP and cron implementations show why scope and row identity must be explicit (`McpServersPage.tsx:64-67`; `JobsSettings.tsx:258-298`).
- Preserve server response canonicalization, query-cache updates/invalidation and clamping. A successful request must not leave a stale draft or optimistic cache value visible; `useWriteProjectFile` and `BrainRuntimeSection` are the reference behaviors (`mutations.ts:360-375`; `BrainRuntimeSection.tsx:58-75`).
- Never save the initial server seed, never overwrite a dirty draft from a refetch, flush pending edits before close, and keep failed edits available for Retry. These are hard invariants, not optional polish.
- Keep localStorage persistence explicitly separate from server persistence. A single source of truth for UX means one owner per data category, not one transport for every stateful value.
- Because bundles cannot compile against `/var/www/elowen/web`, any new shared persistence primitive must be published through the runtime contract and API-versioned compatibly; plugin bundles must consume the host implementation rather than copy it.
