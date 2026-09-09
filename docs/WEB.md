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
| `/dash` | core | Workspace home: a strip of today's figures, a hero with greeting, quick actions, and composer, a recap strip, and disclosure panels for the activity feed, team pulse, and metrics. |
| `/chat` | core | Full-page advisor chat. |
| `/memory` | core | Account memory, categories, retrieval, and memory administration. |
| `/projects` | core | Project registration, access, read-only Git state, and plugin project panels. |
| `/settings` | core | Administrator-only settings deck with `system`, `brain`, `models`, `plugins`, `dashboard`, and `data` sections. The retired `memory` category aliases to `models`. |
| `/users` | core | Administrator-only account and access management. |
| `/account` | core | The signed-in account's settings deck: profile, plugin-contributed sections, Models, Memory, Personality, Notifications, Security, and Terminal. |
| `/p/<plugin>/<...rest>` | plugin host | A page contributed by an enabled plugin. |
| `/editor` | compatibility route | Redirects to the optional editor plugin page at `/p/editor`. |

## Sidebar navigation

There is exactly one navigation: a left sidebar column built on the shadcn Sidebar primitive, mounted once in `web/components/shell/Shell.tsx`. A skin restyles the one column by overriding the `--sidebar-*` tokens rather than mounting a different tree.

The column, top to bottom (`web/components/shell/SidebarNav.tsx`): an instance-switcher header showing the brand mark, the app name, and the running `v<version>`, with a dropdown linking to `/account` and `/settings`; a search row that opens the command palette and shows a `⌘K` / `Ctrl K` hint; the destination list in labelled groups; a footer with a "show hidden" button; and a rail edge handle for collapsing.

The groups, in draw order (`web/components/shell/navGroups.ts`), are `primary` (unlabelled: Home, Chat), `work` (labelled "Work": Projects, Memory, and every plugin world), and `instance` (labelled "Instance": Settings, Users, the changelog plugin page, and Account). Empty groups are dropped.

The entries come from `web/components/shell/useShellNavigation.ts`: the four core worlds of `web/modules/registry.ts` (`home` at `/dash`, `chat` at `/chat`, `projects` at `/projects`, `memory` at `/memory`), then the plugin worlds, which appear only while their plugin is installed, enabled, compatible, and visible to the current account, then `account`, then the admin-only `settings` and `users`. The default order for a user who has never rearranged anything is in `web/components/shell/navOrder.ts`; once the user arranges the menu, their own order wins outright.

Customisation happens in the menu itself, never on a settings page (`web/components/shell/NavCustomization.tsx`). Right-click or long-press an entry for Hide, Move up, Move down, a "Hidden (n)" submenu that restores an entry, and "Restore default order"; right-click empty sidebar space or use the footer button for the same surface menu. Drag-to-reorder is pointer-driven with a 5 px threshold and is desktop only: it is disabled in the drawer and for touch. The layout is two id lists (`hidden`, `order`) resolved by `web/lib/navLayout.ts` and saved server-side with an optimistic cache write, then mirrored to `localStorage` per account. Unknown ids are carried rather than dropped, and new entries append at the end.

Submenus are inline collapsible accordions. An entry gets a submenu only when it has two or more sub-pages; with one child it stays a plain link. When a submenu exists, the parent is a disclosure button rather than a link, and the parent's own page sits inside the submenu. Several submenus can be open at once, and the open set persists per account. In the icon rail, a submenu collapses to its parent destination.

Settings and Account are decks whose sections are declared as sidebar sub-items, so the sidebar is the only navigation between their sections; the in-page section rail that used to sit inside Account is gone. Active-route resolution (`web/components/shell/useSidebarRoute.ts`) scores the path prefix plus a matching `?cat=` and a matching hash, so `/settings?cat=models` beats plain `/settings`. Only `cat` is treated as an addressing parameter.

The only live badge in the sidebar is on Chat: the count of conversations currently working, read from the shared sessions cache. Zero renders no badge. A plugin's own `badge` is used where the shell has no counter of its own.

Keyboard shortcuts: `Ctrl`/`⌘` + `\` folds the sidebar, matched by key code so non-US layouts work, and `Ctrl`/`⌘` + `K` toggles the command palette. Both are advertised through `aria-keyshortcuts`. There are no other global bindings.

The top bar (`web/components/shell/TopBar.tsx`) has two variants: a frameless floating masthead and a sticky ruled bar. It carries the hamburger in drawer mode, a nav collapse toggle in bar mode, the page location or eyebrow plus title, a portal slot where route-owned toolbars mount, and then the action cluster: the command-palette search glyph, sign out, skin switcher, language switcher, and an avatar linking to `/account`. On `/chat` at phone width, the whole bar is withheld in the floating design.

The sidebar presents as a full column, an icon rail, or a drawer, decided from the measured width of the nav plus content region (the window minus the advisor dock, not the viewport). The drawer is a dialog sheet with a scrim, a close button, and a focus trap. The ladder in `web/lib/breakpoints.ts` is drawer below 768 px, forced icon rail below 1280 px, and the user's pinned choice with the collapse handle from 1280 px up; the `command` shell profile that both shipped skins use instead applies a 1024 px drawer boundary and lets the pin decide above it. Arriving at a route closes the drawer.

## Command palette and site search

The command palette (`web/components/shell/CommandPalette.tsx`) is the site search. `Ctrl`/`⌘` + `K` toggles it, and the sidebar search row and the top-bar search glyph open it by dispatching the same window event. The dialog is mounted only while it is open.

What it does is navigation: selecting a row routes to it and closes the palette. Rows are grouped under pages, settings, account, and plugins; the actions group exists in the model, but nothing is filed under it today. It does not search conversations, and it does not search documentation.

With an empty query it is a calm launcher: pages plus the Settings and Account sections only. Typing reveals the individual rows inside those sections and the plugin pages.

The lexical index is built in the browser from static sources: every core module route, every Settings section and its static rows, the provider group titles of Settings → Models, every Account section and its rows, and every plugin page. Runtime plugin and model lists, plugin account sections, per-user plugin config sections, and dynamic counts are deliberately not indexed. Titles come from the localization dictionary, never re-typed. Matching is diacritics-insensitive, and the matched substring is highlighted.

A semantic pass calls `POST /search/rank` only when the query is at least 3 characters and fewer than 3 lexical hits were found. It is debounced 300 ms, aborted on each keystroke, and renders its results under a separate suggestions heading. Any non-abort failure silences the semantic layer for the rest of that palette session.

The "Ask AI" fallback is explicit-click only. It appears solely in the empty state, when a query has produced no lexical group and no suggestion, and calls `POST /search/ask`.

Both routes are open to any authenticated user. Per-user rate limits are 30 requests per minute for `/search/rank` and 10 per minute for `/search/ask`, measured in a 60-second window; exceeding one returns `429`. Missing or failing embeddings, or no configured ask model, return `503` with a specific reason. Ranking bounds a request to 400 candidates and 200 characters per text, id, title, subtitle, and query, and refuses an over-limit request with `400` rather than truncating it. It is cosine similarity returning at most 12 hits scoring at least 0.3, and candidate vectors are cached by embedding model plus exact text, so the steady state embeds only the query. Ask runs on the shared categorization inference route with a 15-second timeout, returns at most 5 results, and filters its reply to the candidate ids that were supplied.

## Application structure

- `web/app/` contains route shells, the root layout, and the same-origin `/api/[...path]` backend-for-frontend (BFF) proxy.
- `web/components/` contains the shell, navigation, overlays, state components, terminal settings preview, and shared UI primitives.
- `web/modules/` contains core feature views such as Dashboard, Chat, Projects, Memory, Settings, Users, and Account.
- `web/lib/` contains the daemon client, React Query hooks and mutations, transcript folding, authentication helpers, localization, plugin loading, and UI state.
- `web/tests/` contains Vitest, React Testing Library, user-event, and MSW tests.
- `packages/plugin-ui-kit/` is the shared contract and component package for plugin browser UIs.

Every route is dynamic (`dynamic = 'force-dynamic'`) because skin, branding, plugin navigation, locale, and authentication state are read at request time. The root `Shell` supplies providers for authentication, React Query, localization, branding, effects, navigation, route transitions, toasts, the command palette, and the advisor dock.

## Core page behavior

- **Dashboard** is a server component at `/dash` whose only job is to prefetch the caller's recap and pass it as a seed, so the hero paints with the agent-written greeting instead of flashing the static time-of-day line; a null seed degrades to the client query. `DashboardView` renders a strip of four figures (turns, tokens, spend today, working now), a centred hero with greeting, ask line, quick-action pills and composer, the recap strip, and three disclosure buttons revealing at most one panel: activity feed, team pulse, or metrics. Panels mount only while open, so their queries stay off the first paint; while setup is incomplete, a setup pill keeps its place among the quick actions.

  `GET /dash/recap` is strictly per-caller and returns up to 3 conversations to reopen, yesterday's turns and tokens plus up to 4 conversation titles, and the digest block. The digest is one row per user and UTC day, generated lazily and never for a user with no yesterday, refreshed on equal windows derived from the configured runs per day, with bounded retry: an hour between attempts, at most 3 per day, and a generating row older than 10 minutes treated as a crashed run. A refresh keeps serving the digest it replaces rather than blanking the hero. Generation reads server-side only and creates no session: user name, agent name, the day, yesterday's usage, at most 8 conversations, at most 10 of the user's own messages per conversation, and at most 12 recent memories, each truncated. The configured variant count sizes both the prompt and the stored batch, and rotating through that batch is client-side and costs no inference: a 12-second cycle with a crossfade that pauses on hover, on focus within the hero, when the tab is hidden, and when the effects mode is not full. The dashboard route reads lightweight conversation references (id, title, updated timestamp, active flag) rather than the full conversation listing, whose per-conversation token rollup would read every message the account owns. `POST /dash/recap/regenerate` is admin-only and self-scoped: it drops only the caller's row for today.
- **Chat** uses `BrainChatProvider` as the single controller for transcript state, draft text, attachments, queues, questions, plans, model selection, and the SSE stream. The dock and full-page chat share that controller, so opening or closing the dock does not create a second stream.
- **Projects** displays registered filesystem roots and the daemon's read-only Git snapshot. Administrators can create, edit, remove, and assign Projects; members can only use Projects granted to them. Enabled plugins can add project panels, such as Sandbox workspaces or a GitHub repository mapping.
- **Memory** operates on the signed-in account's memory. Categories, retrieval, embeddings, and categorization are separate server capabilities; a missing embedding model does not make the browser invent local memory state.
- **Settings** is administrator-only; a non-admin who deep-links gets an explicit "Administrators only" state. The sections, in draw order, are `system` "System", `brain` "{agentName} AI" (interpolated, for example "Elowen AI"), `models` "Models", `plugins` "Plugins", `dashboard` "Recap", and `data` "Data". Sections are addressed as `/settings?cat=<id>`, remembered in local storage, kept in step with the URL, and each panel stays mounted after its first visit; a `?row=` deep link scrolls to and blinks a row. Settings → Models renders a "Model roles" group first, then a "Model catalog" group with per-provider cards, per-model enable toggles, and a limits button for context window and max output tokens. There is no `memory` section: an old `?cat=memory` link is aliased to `models` before the id is validated, so old bookmarks land on Models instead of falling back to System. Memory configuration now lives in the embedding and utility model roles in Settings → Models, memory retention and recall limits inside Settings → {agentName} AI, and per-user recall preferences in Account → Memory; "Memory" at `/memory` is the memory register, not a settings section. Plugin-contributed settings sections are no longer part of the deck: a remembered or linked `plugin:<name>:<id>` category redirects to that section under `/p/<plugin>`, and one whose plugin is gone falls back to System.
- **Account** is the signed-in account's settings deck, addressed as `/account?cat=<id>`. The sections, in draw order, are `profile` "Account", then the plugin-contributed account sections and per-account plugin config sections, then `cli` "Models", `memory` "Memory", `personality` "Personality", `notifications` "Notifications", `security` "Security", and `terminal` "Terminal". A plugin account panel placed as `linkedAccount` claims no section and hangs inside the profile's Linked accounts drawer. Account → Models is the personal counterpart to Settings → Models. Its "Model roles" group carries the primary model, the model every new conversation of this account starts on (empty inherits, and the control names what inheritance actually resolves to); reasoning effort, whose options are the current model's own levels and which is cleared automatically when the newly chosen model cannot accept it; the vision model; the compaction model, which inherits the effective primary; and a read-only per-project models summary with a Manage drawer whose only action is Clear, because repointing a project is what the chat picker already does at the point of use. An admin-only "Instance models" row links to Settings → Models. A second group, "Chat runtime", carries auto-compact with a percentage and per-model thresholds, Fast mode, YOLO behind a confirm dialog, unattended asks, and the permission rules card. A model role is a provider plus model pair (`web/lib/modelRoles.ts`): an empty pair means inherit, and a non-empty pair absent from the current catalog renders an "unavailable" badge naming the dead pick and the model that runs instead.
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

`elowenClient` is the single browser API client. React Query hooks in `web/lib/queries.ts` own query keys and reads; `web/lib/mutations.ts` owns writes, invalidation, and optimistic rollback behavior. Revision-backed mutations carry the last canonical `revision` as `expectedRevision`; HTTP `409` is a first-class conflict rather than a generic failure. The shared autosave controller serializes writes, protects newer drafts from stale responses, flushes valid pending edits on teardown, and preserves recoverable drafts after validation or transport errors. Core and enabled plugins publish state changes on the global daemon event stream, allowing affected queries to invalidate without turning every page into a polling loop.

The chat controller uses `/api/brain/start`, `/api/brain/messages`, `/api/brain/status`, `/api/brain/send`, and the `/api/brain/stream` SSE endpoint. It binds a stable browser client identity and conversation generation to sends so a stale tab cannot write into a newer selection. History is loaded newest-first and older pages are fetched only when the user scrolls upward. SQLite-backed daemon state is authoritative; the browser transcript is a projection that can be rebuilt after reconnect.

The browser may also use bounded polling for slow-moving data such as health, usage, model catalogs, and background processes. Prefer an existing query and event invalidation path before adding a new interval.

## Plugin browser UIs

The authenticated `/api/plugins/ui` listing describes enabled plugin navigation, account sections, User and Project panels, settings sections, bundle URLs, and API versions. `web/lib/pluginUi.tsx` loads a plugin bundle only after the listing says it is available and compatible. The host installs `window.ElowenUiRuntime` (currently API 16) with the host React/JSX runtime, curated components and hooks, authenticated API access, utilities, and SPA navigation; bundles must use `elowen-plugin-ui-kit` and must not import host `web/` modules.

The host route resolves pages under `/p/<plugin>/...`, renders plugin settings sections when addressed as `/p/<plugin>/settings/<id>`, and wraps plugin output in `PluginErrorBoundary`. A plugin that is disabled, not granted to the account, incompatible, or failed to load gets an explicit unavailable state instead of a fabricated empty page.

A plugin's pages are read at one of two measures, declared in the manifest as `web.layout` (`src/plugins/manifest.ts`): `document`, the capped centred reading column, or `workbench`, 90% of the room the workspace has after the advisor dock. The declaration must live in the manifest because the frame belongs to the host shell, which sits above the plugin's markup in the DOM, so no stylesheet a bundle ships can widen it. The shell treats a `/p/<plugin>` route as a workbench only when the cached plugin UI listing reports that layout; an unknown plugin or a daemon too old to send the field reads as document. On a workbench route the shell's own content cap stands down, so the two caps do not multiply.

Plugin pages share the host's authentication, React Query runtime, localization, navigation, overlay policy, and UI kit. API 16 exposes the host-owned `AutoSaveStatus`, `useAutoSaveStatus`, and `usePluginConfigDraft` contracts, including the `pending` state, retry/flush operations, revision forwarding, and explicit `commitValue` boundary for secrets or other values that must not debounce. A registration may contribute pages, account panels, administrator User panels, Project panels, and settings sections; settings report save state through `onSaveState`, and a settings section reached as a page gets a host page frame and header carrying the autosave status unless the registration lists that section id in `ownsPageFrame`, in which case the host renders only the masthead header and the section owns every pixel. Plugin code owns its domain behavior and calls its authenticated plugin API; core does not mirror plugin tables or silently create replacement routes.

The bundled `sandbox` plugin contributes a Project panel at `Sandbox` and an administrator User-detail panel at `Development environment`. It provides account-owned Git worktrees, persistent account HOME, process leases, explicit-path commits, and cleanup previews. The optional GitHub plugin contributes account and Project panels for an account's GitHub connection, Project repository mappings, pull requests, checks, reviews, branch publication, and explicitly confirmed merges. GitHub publication requires both a verified repository mapping and an active Sandbox workspace.

## Shared UI and responsive rules

The shell uses the compiled Studio design family and semantic tokens in `web/app/globals.css` and `web/app/styles/`. This build has exactly two selectable skins: `studio-light` and `studio-oled`; both use the command-style Studio shell and differ in their token paint. Navigation responds to measured available space rather than only the viewport:

- the one sidebar presents as a full column, an icon rail, or a drawer, decided from the measured nav plus content region rather than the viewport (see "Sidebar navigation");
- a left, right, top, or bottom advisor dock reduces that measured region, and a dock on the left edge moves the sidebar to the right edge so the two never share a side; top and bottom docks span the full width above and below the row;
- `/chat` reads its own, wider application measure rather than the capped document column, and on `/chat` at phone width the whole top bar is withheld in the floating design.

Use the shared shadcn/ui components backed by Radix primitives and app wrappers such as `WorkspaceShell`, `WorkspacePage`, `ControlSurface*`, `WorkspaceDetailRail`, `Modal`, `ActionMenu`, `ContextMenu`, `SelectMenu`, `HelpTip`, and the shared state components. Radix owns dialog/menu focus management, keyboard interaction, Escape, and presence; the app's overlay stack adds `inert` isolation, scroll lock, depth/layer policy, focus return, safe-area geometry, and responsive presentation. Do not reimplement these behaviors or add a second portal/overlay stack. Use semantic theme tokens rather than feature-local colors. Preserve visible focus, keyboard operation, reduced-motion handling, and safe-area behavior on small screens.

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

For UI changes, cover loading, error, empty, keyboard/focus, autosave, responsive, and localization states that the changed component can reach. For chat-stream, plugin, or authentication changes, exercise the real browser path in addition to component tests; the relevant Playwright commands are `npm --prefix web run e2e:smoke` and `npm --prefix web run e2e`.

See [`TESTING.md`](TESTING.md) for the repository-wide verification matrix and [`PLUGIN_DEV.md`](PLUGIN_DEV.md) for plugin UI contracts.
