---
title: Web UI
slug: web-ui
order: 5
eyebrow: Everyday use
group: Everyday use
---

# Web UI

The Web UI is the browser interface to your Elowen daemon. After you sign in, the shell gives you a Studio navigation column or rail, a shared advisor dock, account controls, and a command palette. The browser and CLI operate on the same server-side conversations and account permissions.

The root URL redirects to `/dash`. The default landing page is intentionally lightweight: detailed activity panels load only when you open them.

## Navigation

The core navigation is deliberately small:

| Route | What it contains |
| --- | --- |
| `/dash` | Home view with today's totals, personalized actions, setup status, and optional activity, team, or metrics panels. |
| `/chat` | Full-page conversation with history, model controls, live work, and telemetry. |
| `/projects` | Projects you can access, their filesystem paths, access assignments, and Git status. |
| `/memory` | Your account's durable memories, categories, relationship map, maintenance, and lifecycle actions. |
| `/account` | Your profile and account-level CLI, memory, personality, notification, security, and terminal preferences. |
| `/users` | Administrator-only account and access management. |
| `/settings` | Administrator-only daemon, model, plugin, memory, and data settings. |

Plugin UIs can add navigation worlds at runtime. Their pages use `/p/<plugin>` and `/p/<plugin>/<route>`; a plugin with only one settings section may use the shorter `/p/<plugin>` address. A plugin must be enabled and available to your account before its navigation appears.

Your navigation layout is stored per account. You can hide or reorder destinations from the navigation menu; hidden destinations remain reachable from a direct URL or the command palette. On desktop, drag destinations to reorder them. Plugin worlds with multiple pages open their nested pages from the mobile drawer; the compact desktop rail links to the world's default page.

![Elowen's dashboard](images/web-ui-dashboard.png)

### Dashboard recap

When dashboard recap is enabled, the home view can show a short summary of yesterday's conversations, up to two **Continue** pills for recent sessions, and up to three suggested next steps. Continue opens the stored conversation; a suggestion places its prompt in the advisor composer. While an agent digest is being generated, the dashboard uses a deterministic sentence based on yesterday's session titles instead of showing an empty state. Recap data is per account and remains optional.

The dashboard's permanent strip reports today's turns, tokens, cost (or an explicit unavailable/unpriced state), and people currently working. **Show feed**, **Show pulse**, and **Show metrics** reveal at most one detailed panel at a time, so the initial page does not fetch or render those heavier views.

## Shared shell controls

The current build ships two skins in the Studio family: **Light** (`studio-light`) and **Dark/OLED** (`studio-oled`). They share the same command-oriented shell, navigation, routes, controls, and behavior; the OLED variant changes the visual tokens for a near-black display. The instance allow-list determines which choices are available; the selected skin is browser-local rather than an account setting. Switching skins is immediate and does not reload the page or discard an active conversation.

The top bar provides:

- the current page title and location;
- the command palette, opened with the search button (`Ctrl+K` or `⌘K` on desktop);
- language selection;
- your account menu and sign-out control.

The UI's shared controls are built from the local shadcn/ui primitive layer, using Radix behavior where appropriate. App-level wrappers keep Elowen's established labels, variants, design tokens, focus handling, and responsive behavior; this is not a separate visual product or a stock shadcn theme.

On wide screens the navigation is a column or compact icon rail. On narrow screens it opens as a drawer over the page. Use `Escape` or the backdrop to close the drawer; focus stays inside the open drawer and returns to the menu button when it closes. The column can be folded with `Ctrl+\` or `⌘+\` when that control is available.

The advisor launcher opens the chat dock from other pages. `/chat` uses the full-page chat instead of opening a second dock. Plugin pages are hosted under `/p/<plugin>` or `/p/<plugin>/<route>` and appear only when the corresponding plugin UI is available to your account.

## Chat

Open `/chat` for the full conversation surface. It uses the same conversation controller as the chat dock, CLI, and channel adapters.

- **Composer:** send messages, use slash commands, attach files, paste images, and queue follow-ups while a turn is running. The slash menu supports keyboard selection; `Enter` sends unless you hold `Shift` for a new line.
- **Model controls:** choose a model, reasoning effort, fast mode, plan/build/workflow mode, and conversation-level YOLO where permitted.
- **History drawer:** search, rename, fork, export, delete, or start conversations. The register also lets you inspect available sessions and open one in chat.
- **Live work:** see todos, sub-agent progress, workflow nodes, tool calls, and background processes.
- **Telemetry:** inspect context and usage, goals, workflows, sub-agents, processes, the active Project, MCP, and LSP state.

The daemon is authoritative for the transcript and pending queue. Messages sent while a turn streams are shown as queued items, can be removed before delivery, and can be recalled into the composer with `Arrow Up` when the composer is empty. The chat controller stays mounted while you switch routes, open or close the dock, or switch skins, so the draft, transcript, queue, scroll position, and live stream are preserved.

On desktop, telemetry can stay open as a column beside the conversation. On mobile it opens as a drawer. Conversation history is loaded in pages, so older messages appear as you scroll upward. Sessions opened as read-only channel or task history show a read-only notice instead of the composer; exit that view to continue in a writable conversation.

## Projects

Open `/projects` to browse the Project roots configured for Elowen. A Project is a path boundary: access is assigned to accounts by an administrator, and members cannot register, edit, or remove Projects.

Select a Project to open its detail panel. The core overview can include:

- the Project slug, path, and notes;
- the current branch and clean/changed state;
- ahead/behind counts;
- available branches and recent commits.

Administrators also see the **Access** section for assigning non-admin accounts to the Project. Removing a Project from Elowen detaches its registration; it does not delete files from disk.

![Projects workspace](images/projects-list.png)

### Plugin surfaces

Enabled plugins can contribute UI to several parts of the Web UI. These surfaces are not part of core Projects and are loaded from the plugin's registered browser bundle:

- navigation pages under `/p/<plugin>`;
- plugin settings pages, including standalone settings routes;
- account sections;
- administrator user panels;
- tabs in a Project detail panel.

Project tabs sit beside the core **Overview** tab and, for administrators, **Access**. A plugin tab owns its own content and may provide its own page frame; the host supplies loading, compatibility, and failure states. Plugin settings retain their save status when opened as a standalone page.

For example, **Sandbox** can provide account-scoped Git worktree management, while **GitHub** can provide repository and pull-request views. Their availability and exact actions depend on the installed plugin, its grants, and the account's Project access. External actions such as publishing, pull-request creation, reviews, and merges require the plugin's server-side checks and confirmation.

## Memory

Open `/memory` to manage durable facts belonging to your account. The workspace provides two views:

- **List** — search and filter memories by status, kind, category, and text; sort and select records for bulk actions.
- **Brain** — inspect the scalable relationship map of your memories.

The workspace also provides owner-scoped reindex and recategorization maintenance. Retrieval inspection remains available through `POST /memory/retrieve`, not a separate Web tab.

Select a memory to open its detail panel. Depending on its state, you can edit its category, merge it with other records, restore it, or permanently purge it. Personal memories are not visible across accounts.

## Account

Open `/account` for settings that belong to your account rather than the whole daemon. The profile section includes your display name, email, avatar, default Elowen AI model, interface scale, visual-effects preference, and links to your Discord, Microsoft Teams, Telegram, or WhatsApp identity where supported.

Other sections cover:

- **CLI** — personal Elowen/CLI behavior and model settings;
- **Memory** — recall and memory-saving preferences;
- **Personality** — your instructions and response style;
- **Notifications** — browser push notifications;
- **Security** — password changes;
- **Terminal** — terminal appearance and behavior.

Plugins can add account sections. For example, the GitHub plugin adds **GitHub** under Account. Sandbox exposes **Development environment** in the administrator Users detail for the selected account, while workspaces remain under **Project → Sandbox**.

## Administration

Only administrators can open `/users` and `/settings`.

`/users` manages accounts, administrator status, Project assignments, plugin grants, model access, and tool access. Select an account to inspect or change its access context.

`/settings` contains the daemon-wide sections:

- **System** — service readiness, updates, and token lifetime;
- **Elowen AI** — provider configuration, agent identity, limits, retention, runtime, and context windows;
- **Models** — visible presets and custom model entries;
- **Plugins** — installation, enable/disable state, grants, logs, and plugin configuration;
- **Memory** — embedding and categorization configuration;
- **Data** — administrative maintenance and cleanup.

Plugin settings are owned by the plugin and open in that plugin's page, not as a second copy inside core Settings. Plugin credentials stay server-side; the browser receives metadata and status, not secret values.

## Responsive and accessible behavior

The same navigation and controls work with keyboard, mouse, and touch. Lists support keyboard selection and visible focus, statuses are conveyed with text as well as color, and mobile detail panels become drawers. Destructive or external actions show a preview before confirmation; the server performs the final authorization and stale-state check.

[Next: CLI](cli)
