# Web UI

The web application is a Next.js 16 App Router app in `web/`, built with React
19, Tailwind CSS 4, TanStack React Query, Motion, Xterm.js, Monaco, and an
optional React Three Fiber mascot scene.

## Application structure

`web/app/` owns Next route shells, the same-origin API proxy, and global CSS.
`web/modules/` owns feature views; `web/components/` owns the app shell and
shared controls; `web/lib/` owns the API client, query/mutation hooks, i18n,
and UI state.

Most page routes are client components with `dynamic = 'force-dynamic'` and
render their feature inside `ModuleShell`. The global `Shell` provides auth,
React Query, localization, effects preferences, navigation, route transitions,
toast feedback, command palette, and the optional advisor dock. `/terminal/*`
is intentionally chromeless while retaining the providers and auth gate.

## Routes

| Route | Primary view | Notes |
| --- | --- | --- |
| `/dash` | `DashboardView` | Dashboard retains its dedicated overview composition |
| `/stats` | `StatsView` | Usage, activity, and operational statistics |
| `/tasks` | `TasksView` | Mission/task workspace, filters, and detail drawer |
| `/kanban` | Kanban + calendar | Board/calendar switch in one route |
| `/sessions` | `SessionsView` | Live agents and terminal access |
| `/timeline` | `TimelineView` | Activity and commit context |
| `/memory` | `MemoryView` | Memory list, retrieval, and graph-oriented views |
| `/escalations` | `EscalationsView` | Pending reviews and parked questions |
| `/projects` | `ProjectsView` | Projects, repository context, and detail drawer |
| `/editor` | `EditorView` | Dedicated editor workspace |
| `/terminal/[name]` | terminal pop-out | Chromeless terminal route |
| `/settings` | settings control surface | Administrator-only configuration sections |
| `/users` | `UsersView` | Administrator user and access management |
| `/account` | `AccountView` | Per-user profile and preferences |
| `/onboarding` | first-run wizard | Setup and readiness flow |

Feature metadata lives in `web/modules/<feature>/meta.ts` and is registered in
`web/modules/registry.ts`. `ModuleHeader` publishes a route's title/count to
the shell state and browser title; it does not impose an additional fixed page
header.

## Shared layout patterns

The product uses a small number of shared patterns rather than page-specific
card stacks:

- `SpatialWorkspaceLayout` combines the section hero, mascot/metrics, optional
  section rail, responsive content, and a contextual detail drawer. Tasks,
  projects, timeline, memory, users, Kanban, and escalations use it where a
  data workspace benefits from the pattern.
- Settings and Account use their dedicated spatial control decks. Their section
  content is wide and scrollable; it is not rendered inside the orbit itself.
- `ControlSurfaceDocument`, `ControlSurfaceToolbar`, and
  `ControlSurfaceRegister` provide the common document/toolbar/register rhythm
  for dense editable content.
- `WorkspaceDetailRail` is portaled to the document body and becomes a focus-
  managed drawer. It preserves context on desktop and mobile instead of
  navigating away from the source list.
- Dashboard, Editor, and Terminal keep their specialist compositions instead
  of being forced into the workspace pattern.

The shared `overlayStack` handles modal/drawer layering, body scroll lock,
focus restoration, Escape behavior, and keyboard focus trapping. Menus share
the same keyboard semantics through `MenuSurface`; new overlay code should
reuse these primitives.

## Data and real-time behavior

`web/lib/elowenClient.ts` is the single browser client. It calls `/api`, uses
`credentials: 'same-origin'`, and turns a daemon 401 into an auth-clear event.
The catch-all `app/api/[...path]/route.ts` BFF reads the httpOnly session cookie
and injects the daemon bearer server-side. Never add a browser-visible daemon
token or a `NEXT_PUBLIC_*` secret.

The proxy holds no authorization logic of its own: a tokenless request is
forwarded without an `Authorization` header and the daemon's global guard
decides — first-run setup routes stay open while no admin user exists, and
every protected route returns 401 thereafter. The cookie-clear on a daemon 401
applies only when a token was actually sent, so the pre-cookie onboarding window
is not flipped to a logout. Do not reintroduce a proxy-side gate; the daemon is
the sole authority (`src/api/auth.ts`).

## Daemon↔web wire contract

The display-transcript shapes served by `GET /brain/messages` are defined once
in `src/shared/wireContract.ts` and imported type-only by both toolchains: the
daemon re-exports them from `src/brain/messageView.ts`, the web imports them in
`web/lib/types.ts`. A type-only import erases at build time, so no daemon
runtime code reaches the Next bundle; a dependency-cruiser exception allows
`web → src/shared/` and keeps the "web never imports the backend" rule for
everything else. Extend the contract there rather than hand-mirroring shapes.

The transcript fold engine (`web/lib/transcript.ts`) is an exception that stays
a hand-synced copy, because a Turbopack bundle cannot import the daemon's
NodeNext runtime source. `tests/contract/transcriptFoldParity.test.ts` folds the
same battery through both the daemon and web engines and asserts identical
output, so the copy cannot drift silently.

React Query hooks in `web/lib/queries.ts` own server reads and cache keys;
`web/lib/mutations.ts` owns writes, narrow invalidation, and safe optimistic
rollbacks. Prefer SSE invalidation to unnecessary polling. The global event
stream keeps task, mission, session, signal, review, decision, and related
views current; individual terminal panes also use their own stream.

## Auth and authorization

`LoginGate` probes `/api/auth/me` before rendering the authenticated app.
Administrators can access configuration and user management; non-admin users
only see data for their assigned projects and their permitted models/tools.
Components should render the server's actual authorization result, not attempt
to duplicate permission decisions in the browser.

## UI conventions

- The UI is OLED dark by design. Tokens and shared styles are imported from
  `app/globals.css` via `app/styles/`; do not create feature-local color systems.
- Use semantic tokens, compact hairline separation, and the red-orange accent
  for active/primary states. Green indicates success; warning colors retain
  their operational meaning.
- Keep normal settings on auto-save with visible saving/saved/error feedback.
  Explicit confirmation remains for destructive, OAuth, permission, and other
  risky operations.
- Reuse `HelpTip`, `ManageSelectionModal`, `SelectionSummary`, the shared model
  picker, form fields, states, and menu/overlay primitives. Do not replace them
  with pill-only selectors or bespoke modal stacks.
- Use CSS Grid/Flexbox, CSS variables, and container queries. The shell adapts
  its navigation using measured available width; content should adapt to its
  own container rather than a global viewport guess.
- Respect keyboard operation, visible focus, reduced motion, and the effects
  preference. Motion should use transform/opacity and never capture pointer
  input from content.

## Mascot and effects

`SpatialMascot` is lazy-rendered and has a static fallback. It belongs in the
spatial decks, workspace heroes, meaningful empty states, and long-operation
status—not as decoration on every surface. The Three scene caps pixel density,
pauses offscreen/when hidden, ignores pointer events, and honors reduced-motion
preferences. Keep new visual effects within the existing motion/token system.

## Terminals and editor

`StreamTerminal` uses a ticketed real-PTY WebSocket when available; `Terminal`
uses the SSE snapshot fallback. Preserve both paths when changing terminal
features. Monaco assets are copied into the standalone package artifact by the
web build, so test the packaged build after changes to editor or asset wiring.

## Testing web changes

Use Vitest, React Testing Library, user-event, and MSW from `web/tests/`.
Cover asynchronous loading/error states, auto-save, keyboard/focus behavior,
selection dialogs, and i18n as relevant. Run:

```bash
npm --prefix web test
npm run build:web
```

See [Testing](TESTING.md) for the full verification matrix.
