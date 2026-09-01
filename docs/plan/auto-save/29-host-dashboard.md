# Dashboard auto-save audit

## Scope

Audited `/var/www/elowen/web/modules/dashboard` and its direct route wrapper. The module contains the `/dash` hero, the home composer, quick-action/recap actions, progressive-disclosure controls, and read-only activity, pulse, and metrics panels. No editable drawer, settings form, toggle, selector, or persistence mutation is implemented under this directory.

The dashboard personalization settings referenced by the module live outside this scope in `/var/www/elowen/web/modules/settings/DashboardSection.tsx:22-26`; they are noted under **Reusable existing pattern**, but are not counted in the surface inventory below.

## Surface inventory

| Surface | Files/lines | Current persistence pattern | Verdict |
|---|---|---|---|
| Home composer | `web/modules/dashboard/HomeComposer.tsx:6-36` | Local `text` state only (`:7`); submit/Enter calls the existing advisor compose bridge and clears the draft (`:8-10`, `:17-23`). No server mutation or save status. | N/A |
| Static and agent-written quick-action pills | `web/modules/dashboard/DashboardView.tsx:92-108`, `:161-171` | Buttons seed the existing advisor composer or open the metrics panel; the setup item is a navigation link. They do not edit persisted data. | N/A |
| Recap continue/suggestion pills | `web/modules/dashboard/RecapStrip.tsx:37-69` | Continue opens an existing session and suggestions seed the advisor composer. No mutation or editable value. | N/A |
| Panel disclosure and close controls | `web/modules/dashboard/DashboardView.tsx:54-71`, `:186-224` | `open` is ephemeral component state; one inline panel is mounted at a time. Escape and the close button return focus but do not persist state. | N/A |
| Activity/feed panel | `web/modules/dashboard/ActivityTile.tsx:128-164` | Read-only `useActivity`/`usePresence` queries; filtering and display only. No form or mutation. | N/A |
| Team pulse panel | `web/modules/dashboard/TeamPulseTile.tsx:14-57`, `web/modules/dashboard/PulseStats.tsx:58-95` | Read-only `usePulse` query and derived statistics. No editable controls. | N/A |
| Metrics panel and destination links | `web/modules/dashboard/MetricsTile.tsx:24-36`, `:39-130` | Read-only usage/cron queries, chart, rings, and links to Stats/Cron pages. No local draft or mutation. | N/A |

## Missing or inconsistent auto-save

- No in-scope editable/configurable surface is missing auto-save: every stateful control in this module is either navigation, an action trigger, or transient disclosure state rather than a user edit that should persist.
- `HomeComposer` intentionally keeps an unsent prompt only in local state and clears it after dispatch (`HomeComposer.tsx:7-10`). This is a compose/send interaction, not a settings edit; applying settings-style auto-save would create an unintended second persistence channel for an advisor draft.
- The dashboard disclosure state is intentionally transient (`DashboardView.tsx:54-71`) and is not a user preference. Persisting the open panel would add state without a demonstrated product requirement.
- The module has no save/error UI because it has no writes. The existing agent bridge preserves and merges drafts when a compose request reaches an already edited chat (`web/lib/brainDock.ts:18-23`), which is the relevant draft-safety boundary.

## Legitimate exceptions

- **Home composer:** explicit submit or Enter is appropriate because the control sends/opens a conversational prompt rather than editing configuration. Shift+Enter remains available for multiline input (`HomeComposer.tsx:17-24`).
- **Quick actions and recap pills:** these are commands/navigation, not editable values; an auto-save indicator would be misleading (`DashboardView.tsx:96-108`, `RecapStrip.tsx:49-67`).
- **Panel open/close and Escape:** ephemeral presentation state, not a preference (`DashboardView.tsx:63-71`, `:208-224`).
- **Metrics links:** navigation to the owning Stats/Cron surfaces is preferable to duplicating their editable controls in the dashboard (`MetricsTile.tsx:32-36`, `:70-80`).

## Reusable existing pattern

The related Dashboard settings surface already uses the shared race-safe auto-save mechanism, although it is outside the requested directory:

- It seeds local state from persisted config before enabling writes (`web/modules/settings/DashboardSection.tsx:45-59`).
- It saves the complete dashboard config through the daemon and invalidates both recap and config queries (`:66-76`).
- It uses `useAutoSaveStatus` with the seeded dependency list (`:78-85`), providing the standard debounced save, stale-response protection, retry, and visible status behavior implemented in `web/lib/useAutoSaveStatus.ts:7-24` and `:45-105`.
- The settings controls are toggles, choices, and a model selector (`DashboardSection.tsx:111-191`); they should remain owned by Settings rather than being duplicated in `/modules/dashboard`.

## Tests and gaps

- `web/tests/modules/dashboard/DashboardView.test.tsx:84-131` covers first paint, lazy mounting, the local composer presence, and loading placeholders.
- `web/tests/modules/dashboard/DashboardView.test.tsx:133-160` covers quick-action dispatch and the setup navigation fallback.
- `web/tests/modules/dashboard/DashboardView.test.tsx:217-286` covers panel disclosure, exclusive mounting, focus movement, Escape, and close behavior.
- `web/tests/app/dash.test.tsx:21-56` covers the route wrapper, first-paint panel absence, and resilience to incomplete pulse payloads.
- There is no dedicated `HomeComposer` test asserting that an unsent local draft is intentionally cleared on submit or that Shift+Enter preserves the draft. This is a low-risk coverage gap, not an auto-save defect.
- The related settings autosave behavior should be covered by settings tests owned by that surface; it is not duplicated here.

## Recommended migration notes

- Keep the dashboard module read-only/action-oriented. Do not add an auto-save layer to the composer, quick actions, recap pills, or disclosure state.
- Keep dashboard personalization edits in `DashboardSection`; it already has the canonical autosave implementation and invalidates the dashboard recap query after writes.
- If product requirements later introduce a persistent dashboard layout preference, model it as a dedicated settings field and reuse `useAutoSaveStatus` with seeded state, validation, visible status, retry, and query-cache invalidation. Do not persist the current `open` panel state implicitly.
- Consider a focused `HomeComposer` regression test for Enter versus Shift+Enter and post-submit clearing if the composer behavior changes.
