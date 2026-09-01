# Scope

Audit of the registry `stats` plugin's web, configuration, detail/drawer, and persistence surfaces. The authoritative plugin source is `/var/www/elowen-plugins/plugins/stats`; host-owned query, mutation, persistence, and API behavior was traced in `/var/www/elowen`.

The plugin is an analytics surface over the host's usage ledger. It has no editable business form or plugin-owned server configuration. Its only durable UI preference is the selected date range.

# Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Registry/web registration and navigation | `plugins/stats/elowen-plugin.json:2-18`; `plugins/stats/web-src/index.tsx:1-4`; `plugins/stats/web-src/runtime.ts:116-129` | Manifest declares one browser entry and one `Statistics` route. Registration is declarative; no user data is written. | N/A |
| Plugin configuration surface | `plugins/stats/elowen-plugin.json:8-18` | `provides` is empty and the manifest has no `config` or `settings` declaration. No config editor, config hook, or config mutation exists in the plugin source. | N/A |
| Main statistics page and read-only analytics | `plugins/stats/web-src/StatsView.tsx:111-149`, `223-375` | Reads `useModelUsage` and `useUsageByDay`; host query hooks poll and cache results. Search, filter, and pagination are local React state. There is no draft or editable record to auto-save. | N/A |
| Date-range filter | `plugins/stats/web-src/StatsView.tsx:114-124`, `173-198`; `web/lib/usePersistentState.ts:4-34`; `web/lib/dateRange.ts:25-48` | `elowen.stats.range` is written synchronously to `localStorage` on change and rehydrated on mount. Stored values are shape-validated by `isStoredRange`; malformed values fall back to the default range. | Compliant |
| Search, usage filter, and pager | `plugins/stats/web-src/StatsView.tsx:125-147`, `173-218`, `251-260`, `347-349` | `query`, `filter`, and `page` use component state only. Filter changes reset the page, but none of these view-only values are persisted. | N/A |
| Token/cost charts, trend, model table | `plugins/stats/web-src/StatsView.tsx:277-350`; `plugins/stats/web-src/components/PieChart.tsx:40-111`; `plugins/stats/web-src/components/UsageTrend.tsx:17-31` | Purely read-only rendering over query data. Chart hover state is local and ephemeral; no persistence API is involved. | N/A |
| Model detail rail | `plugins/stats/web-src/StatsView.tsx:76-109`, `319-341`, `368-371` | Selected model is held in `selectedExec` React state and is cleared by the rail close action. It is inspection state, not a draft. | N/A |
| Admin consumption-origin drawer | `plugins/stats/web-src/StatsView.tsx:233-241`, `355-367`; `plugins/stats/web-src/OriginDrawer.tsx:119-229` | Uses host `useUsageByOrigin` queries only. Group, sort, and drill-down selection are local state (`group`, `sort`, `drillUserId`); no mutation or draft exists. The server enforces admin-only access at `src/api/routes/usage.ts:43-78`; the UI gate only suppresses the trigger/request for non-admins. | N/A |
| Origin drawer grouped views and drill-down | `plugins/stats/web-src/OriginDrawer.tsx:131-145`, `149-173`, `201-221` | Group changes reset drill-down; user drill-down filters already server-aggregated pair rows instead of recomputing totals. Results poll through the host query cache; loading, empty, and retry error states are rendered. | N/A |
| Reset usage modal | `plugins/stats/web-src/ResetUsageModal.tsx:8-37`; `plugins/stats/web-src/StatsView.tsx:235-240`, `377`; `web/lib/mutations.ts:8-18` | Explicit `POST /usage/reset` mutation after typing the confirmation word. The button is disabled while pending; success closes the modal and toasts, failure keeps the modal open and shows an error toast. Success invalidates model, day, and origin query caches. | Explicit-save justified |
| Persistence APIs behind the plugin | `web/lib/elowenClient.ts:78-101`; `src/api/routes/usage.ts:9-89` | `GET /usage/by-model`, `GET /usage/by-day`, and admin-only `GET /usage/by-origin` are read APIs. `POST /usage/reset` is the only write and is destructive, scoped to the admin caller, and clears the caller's usage/origin accounting. | Explicit-save justified for reset; N/A for reads |

# Missing or inconsistent auto-save

- No editable plugin-owned settings, credentials, multi-field form, or non-destructive domain edit was found. There is therefore no missing auto-save for the stats domain.
- The date range is deliberately durable through validated `usePersistentState` (`StatsView.tsx:114`), while search, usage filter, pagination, selected model, and origin drawer group/sort/drill state are ephemeral (`StatsView.tsx:125-133`). This is a minor continuity inconsistency, but it does not cause data loss: these controls only change which read-only analytics are displayed.
- The origin drawer does not persist its group/sort choice across close/reopen or reload. Treat this as an optional view-preference decision, not an auto-save defect; adding persistence would require product intent because the current behavior also resets sensitive/admin-only exploration state naturally.
- The reset path must not be converted to auto-save. Automatic clearing of usage data would violate the destructive-operation exception and the existing confirmation contract.
- No stale draft/server-refresh race exists in this plugin. Usage data is server-owned and the host query hooks use placeholder data plus bounded polling (`web/lib/queries.ts:53-95`), while reset invalidates all affected usage caches (`web/lib/mutations.ts:8-18`).

# Legitimate exceptions

- `ResetUsageModal` represents a permanent destructive action: the copy says it permanently clears usage snapshots, requires typing `RESET` (localized), and blocks the action while the mutation is pending (`ResetUsageModal.tsx:17-21`, `24-36`). Explicit confirmation is justified.
- The reset endpoint is admin-only on the server (`src/api/routes/usage.ts:80-89`), not merely hidden in the UI. The origin endpoint is likewise server-gated because it exposes client addresses and cross-account data (`src/api/routes/usage.ts:31-45`).
- The origin drawer is an investigative read surface. Its tracking window, trust warning, and `trackingSince` limitation are rendered with the result (`OriginDrawer.tsx:180-199`), so it does not imply complete all-time attribution.
- There are no secrets, uploads, consent steps, externally verified credentials, or multi-step atomic edits in this plugin.

# Reusable existing pattern

- For a durable, validated view preference, use the host `usePersistentState`: it hydrates from `localStorage`, validates an allow-list/predicate, writes synchronously, and safely falls back in SSR/private-mode cases (`web/lib/usePersistentState.ts:4-34`). Stats already uses the canonical pattern for `elowen.stats.range`.
- For a real editable form in another surface, the host's `useAutoSaveStatus` provides bounded debounce, seed suppression, validity gating, serialized follow-up writes, unmount flush, visible `saving`/`saved`/`error` status, and retry (`web/lib/useAutoSaveStatus.ts:6-30`, `45-105`). It is not appropriate for stats' read-only analytics or destructive reset.
- For a destructive usage reset, the existing `useResetUsage` mutation is the correct shared mechanism: it calls the host client and invalidates all three usage query families on success (`web/lib/mutations.ts:8-18`).

# Tests and gaps

- `tests/api/usageOriginRoutes.test.ts:48-106` covers non-admin `403`, grouped origin results, trust flags, cost-source handling, tracking window, and the unwired-store `503`.
- `tests/api/usageOriginRoutes.test.ts:109-136` covers reset clearing the caller's origin rollup and rejecting non-admin reset attempts without changing counters.
- `web/tests/lib/usePersistentState.test.tsx:10-49` covers fallback, localStorage writes, valid rehydration, allow-list rejection, and predicate validation/rejection.
- `web/tests/lib/mutations.test.tsx:76-87` covers `useResetUsage` invalidating the model and day caches, but does not assert invalidation of the origin cache even though the implementation does so at `web/lib/mutations.ts:14-16`. Add that assertion.
- No focused plugin UI tests were found for `StatsView`, `OriginDrawer`, or `ResetUsageModal`. Existing plugin contract tests validate bundle discovery/string contracts, not persistence or user journeys (`tests/contract/pluginBundleI18nKeys.test.ts:26-85`; `tests/contract/pluginBundleStringKeys.test.ts:48-59`).
- Missing focused UI coverage includes: range persistence through the actual Stats view; reset pending/success/error behavior; drawer admin gating and retry/empty states; and ensuring changing group clears drill-down. These are coverage gaps, not evidence of a current autosave failure.

# Recommended migration notes

- Keep the analytics page, charts, model rail, and origin drawer classified as read-only/N/A; do not introduce auto-save infrastructure where there is no editable domain state.
- Retain `usePersistentState('elowen.stats.range', ...)` and its validator as the canonical persistence for the date range.
- Decide explicitly whether search/filter and origin group/sort should survive navigation. If continuity is desired, persist only those validated view preferences with `usePersistentState`; do not use `useAutoSaveStatus` and do not persist sensitive drill-down state by default.
- Keep reset as explicit, confirmation-gated mutation and extend the existing mutation test to assert `['usage-by-origin']` invalidation.
- Add focused plugin UI tests before any future change to the range, drawer, or reset flows; no migration of a missing auto-save form is currently warranted.
