# Web UI

The Web UI is a Next.js 16 App Router application in `web/`. It is a client-rendered operational interface for the same daemon, conversations, Projects, accounts, permissions, memory, and plugins used by the CLI and channel adapters.

## Development and build

Install the root and web dependencies separately:

```bash
npm ci
npm ci --prefix web
```

Run the daemon and web development server in separate terminals:

```bash
npm run serve
npm --prefix web run dev
```

The daemon listens on `127.0.0.1:4400` by default. The Next.js development server uses port `3000` unless `PORT` is set. The server-side web proxy connects to `ELOWEN_DAEMON_URL`, defaulting to `http://localhost:4400`.

Build the deployable web artifact from the repository root:

```bash
npm run build:web
```

For a direct Next.js production build, use `npm --prefix web run build`. The root `npm run build` compiles the daemon and bundled plugins but does not build `web/`.

## Route map

| Route | Owner | Purpose |
| --- | --- | --- |
| `/` | host | Redirects to `/dash`. |
| `/dash` | core | Dashboard with setup posture, current activity, presence, and recent activity. |
| `/chat` | core | Full-page advisor chat. |
| `/memory` | core | Account memory, categories, retrieval, and memory administration. |
| `/projects` | core | Project registration, access, read-only Git state, and plugin project panels. |
| `/settings` | core | Administrator-only system, brain, model, plugin, memory, and data settings. |
| `/users` | core | Administrator-only account and access management. |
| `/account` | core | The signed-in account's profile, security, notifications, defaults, and personal settings. |
| `/p/<plugin>/<...rest>` | plugin host | A page contributed by an enabled plugin. |
| `/editor` | compatibility route | Redirects to the plugin-owned editor page at `/p/editor`. |
| `/terminal/<name>` | terminal plugin host | An authenticated, chromeless terminal window. |

Core navigation presents Home (`/dash`), Chat, Projects, and Memory. Settings and Users are system destinations. Plugin pages become additional navigation worlds only while their plugin is installed, enabled, compatible, and visible to the current account.

## Application structure

- `web/app/` contains route shells, the root layout, and the same-origin `/api/[...path]` backend-for-frontend (BFF) proxy.
- `web/components/` contains the shell, navigation, overlays, state components, terminal controls, and shared UI primitives.
- `web/modules/` contains core feature views such as Dashboard, Chat, Projects, Memory, Settings, Users, and Account.
- `web/lib/` contains the daemon client, React Query hooks and mutations, transcript folding, authentication helpers, localization, plugin loading, and UI state.
- `web/tests/` contains Vitest, React Testing Library, user-event, and MSW tests.
- `packages/plugin-ui-kit/` is the shared contract and component package for plugin browser UIs.

Every route is dynamic (`dynamic = 'force-dynamic'`) because branding, plugin navigation, locale, and authentication state are read at request time. The root `Shell` supplies providers for authentication, React Query, localization, branding, effects, navigation, route transitions, toasts, the command palette, and the advisor dock. `/terminal/*` keeps those providers and the authentication gate but intentionally omits the normal shell chrome.

## Core page behavior

- **Dashboard** uses `DashboardView` to show the finish-setup prompt when needed, the current activity tile, team presence, and the recent activity feed.
- **Chat** uses `BrainChatProvider` as the single controller for transcript state, draft text, attachments, queues, questions, plans, model selection, and the SSE stream. The dock and full-page chat share that controller, so opening or closing the dock does not create a second stream.
- **Projects** displays registered filesystem roots and the daemon's read-only Git snapshot. Administrators can create, edit, remove, and assign Projects; members can only use Projects granted to them. Enabled plugins can add project panels, such as Sandbox workspaces or a GitHub repository mapping.
- **Memory** operates on the signed-in account's memory. Categories, retrieval, embeddings, and categorization are separate server capabilities; a missing embedding model does not make the browser invent local memory state.
- **Settings** has the core sections `system`, `brain`, `models`, `plugins`, `memory`, and `data`. Plugin-owned settings are pages in the plugin's own world rather than duplicate sections in core Settings.
- **Account** has `profile`, `security`, `notifications`, `personality`, `cli`, `terminal`, and `memory` sections, plus account sections contributed by enabled plugins.
- **Users** is an administrator surface for accounts, Project assignments, and per-account tool access. Members do not receive this route's management authority.

## Authentication and the BFF proxy

The browser never stores or sends a daemon bearer token. `web/lib/elowenClient.ts` uses the same-origin base `/api` with `credentials: 'same-origin'`. The catch-all route `web/app/api/[...path]/route.ts` reads the `elowen_session` httpOnly cookie, adds `Authorization: Bearer <token>` server-side, and streams the daemon response back to the browser, including SSE responses.

Requests without a cookie are forwarded without authorization so first-run setup can remain reachable. After an account exists, the daemon's global authentication guard returns `401` for protected routes. A daemon `401` clears the session cookie only when a cookie was actually sent; a tokenless onboarding request is not turned into a logout.

The proxy also:

- forwards only the allow-listed content and range headers, never a browser-supplied `Authorization` header;
- rejects unsafe path segments before forwarding them to the daemon;
- checks `Origin` on mutating requests as CSRF defense-in-depth;
- removes upstream `Set-Cookie` headers because the proxy owns the browser session cookie.

The daemon remains the authorization authority. The browser must render the server's result rather than duplicate account, Project, plugin, or tool-policy decisions in client code.

## Data and real-time flow

`elowenClient` is the single browser API client. React Query hooks in `web/lib/queries.ts` own query keys and reads; `web/lib/mutations.ts` owns writes, invalidation, and optimistic rollback behavior. Core and enabled plugins publish state changes on the global daemon event stream, allowing affected queries to invalidate without turning every page into a polling loop.

The chat controller uses `/api/brain/start`, `/api/brain/messages`, `/api/brain/status`, `/api/brain/send`, and the `/api/brain/stream` SSE endpoint. It binds a stable browser client identity and conversation generation to sends so a stale tab cannot write into a newer selection. History is loaded newest-first and older pages are fetched only when the user scrolls upward. SQLite-backed daemon state is authoritative; the browser transcript is a projection that can be rebuilt after reconnect.

The browser may also use bounded polling for slow-moving data such as health, usage, model catalogs, and background processes. Prefer an existing query and event invalidation path before adding a new interval.

## Web terminal transport

A terminal window is opened at `/terminal/<name>`. The browser first requests a single-use ticket from `/api/sessions/<name>/ws-ticket`; the WebSocket then sends that ticket to `/ws/terminal`. The daemon bearer token is not placed in the WebSocket URL.

`StreamTerminal` uses the ticketed real-PTY WebSocket when available. `Terminal` remains the SSE snapshot/input fallback. Preserve both transports when changing terminal behavior. The browser can request a direct daemon port from `/api/ws-config` for proxy-less deployments; otherwise the WebSocket is same-origin.

## Plugin browser UIs

The authenticated `/api/plugins/ui` listing describes enabled plugin navigation, account sections, Project panels, settings sections, bundle URLs, and API versions. `web/lib/pluginUi.ts` loads a plugin bundle only after the listing says it is available and compatible.

The host route resolves pages under `/p/<plugin>/...`, renders plugin settings sections when addressed as `/p/<plugin>/settings/<id>`, and wraps plugin output in `PluginErrorBoundary`. A plugin that is disabled, not granted to the account, incompatible, or failed to load gets an explicit unavailable state instead of a fabricated empty page.

Plugin pages share the host's authentication, React Query runtime, localization, navigation, and UI kit. Plugin code owns its domain behavior and calls its authenticated plugin API; core does not mirror plugin tables or silently create replacement routes.

The bundled `sandbox` plugin contributes a Project panel at `Sandbox` and an Account panel at `Development environment`. It provides account-owned Git worktrees, persistent account HOME, process leases, explicit-path commits, and cleanup previews. The optional GitHub plugin contributes account and Project panels for an account's GitHub connection, Project repository mappings, pull requests, checks, reviews, branch publication, and explicitly confirmed merges. GitHub publication requires both a verified repository mapping and an active Sandbox workspace.

## Shared UI and responsive rules

The shell is OLED dark and uses the tokens in `web/app/globals.css` and `web/app/styles/`. Navigation responds to measured available space rather than only the viewport:

- wide regions can use a full navigation column or a compact icon rail;
- narrower regions use a drawer;
- a left, right, top, or bottom advisor dock changes the available region and causes the shell to mirror or stack navigation as needed;
- `/chat` uses an application layout rather than the capped document measure and suppresses the global top bar on narrow screens.

Reuse shared primitives such as `ModuleShell`, `WorkspacePage`, `SpatialWorkspaceLayout`, `ControlSurface*`, `WorkspaceDetailRail`, `Modal`, `MenuSurface`, `HelpTip`, and the shared state components. Use semantic theme tokens rather than feature-local colors. Preserve visible focus, keyboard operation, reduced-motion handling, and safe-area behavior on small screens.

`MascotGlyph` renders the instance's themeable mascot artwork with a per-state ember ring. It is sized in percentages so it is correct in any box, and it ignores pointer input so it cannot block the actual controls.

## Type and dependency boundaries

The daemon and web application share wire types from `src/shared/wireContract.ts` through type-only imports. The daemon re-exports transcript types from `src/brain/messageView.ts`; the web consumes them through `web/lib/types.ts`. Do not import daemon runtime modules into the Next.js bundle.

`web/lib/transcript.ts` is intentionally a hand-synchronised browser implementation because the Next.js bundle cannot import the daemon's NodeNext runtime source. `tests/contract/transcriptFoldParity.test.ts` exercises both fold engines against the same cases. Extend the shared wire contract first, and update the parity cases when changing transcript behavior.

## Verification

Run the focused web suite and production build:

```bash
npm --prefix web test
npm run build:web
```

For UI changes, cover loading, error, empty, keyboard/focus, autosave, responsive, and localization states that the changed component can reach. For terminal, chat-stream, plugin, or authentication changes, exercise the real browser path in addition to component tests; the relevant Playwright commands are `npm --prefix web run e2e:smoke` and `npm --prefix web run e2e`.

See [`TESTING.md`](TESTING.md) for the repository-wide verification matrix and [`PLUGIN_DEV.md`](PLUGIN_DEV.md) for plugin UI contracts.
