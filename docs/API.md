# API Reference

Elowen exposes a Hono REST API from the daemon. The executable contract is implemented in `src/api/routes/`, with request schemas in `src/api/schemas/`.

**Default base URL:** `http://localhost:4400`

The CLI can call the daemon directly:

```bash
elowen api GET /health
elowen api GET /projects
elowen api POST /brain/send '{"text":"Summarize this project","mode":"build"}'
```

`ELOWEN_URL` overrides the daemon URL and `ELOWEN_TOKEN` overrides the token cached by `elowen login`. The web application normally reaches the daemon through its same-origin `/api` proxy and an httpOnly session cookie.

## Authentication and access

Before the first user is created, the daemon is in setup mode and requests are open so onboarding can save configuration and create the first administrator. Afterwards, API requests use a bearer token:

```http
Authorization: Bearer <token>
```

Tokens are accepted in the `Authorization` header only. Query-string tokens are not accepted.

The following paths are public:

- `GET /health`
- `GET /setup`
- `POST /auth/login`
- `GET /auth/sso/providers`
- `POST /auth/sso/msteams/start`
- `POST /auth/sso/msteams/callback`
- `GET /push/vapid-public-key`
- `GET /public/theme`
- `GET /public/theme/assets/:file`
- `GET /ws/terminal` (WebSocket upgrade; the capability is a short-lived ticket)
- `GET /users/:id/avatar` when a valid `exp` and `sig` are supplied
- `/hooks/*` plugin webhook mounts

Authentication is separate from authorization. After authentication, handlers apply administrator checks, per-user plugin grants, project assignments, and resource ownership. A non-administrator with project assignments can access any assigned project; access is not limited to the daemon's home project.

Delegated sub-agents do not receive an `agent` API token. Their captured project, tool, permission, owner, and read-only boundaries are enforced by the delegation runtime.

## Request and response conventions

- Send JSON with `Content-Type: application/json` unless a route says otherwise.
- `POST /brain/uploads` accepts one raw file stream, not multipart form data.
- `POST /auth/me/avatar` accepts multipart form data with a field named `avatar`.
- Handled validation failures normally return `{ "error": "…" }`.
- Invalid JSON and failed Zod validation return HTTP `400`.
- Common status codes are `401` (missing or invalid token), `403` (authorization or project access), `404` (unknown resource), `409` (conflict or runtime state), `413` (payload too large), `415` (unsupported media type), `429` (rate limit), `500` (server error), and `503` (an optional subsystem is unavailable or disabled).
- Error text is diagnostic, not a stable enum. Plugin routes may define additional response shapes and status codes.

## Health, setup, configuration, and events

| Method | Path | Access | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Public | Return `ok`, daemon version, event-loop diagnostics, and optionally sub-agent pool status. |
| `GET` | `/setup` | Public | Return `{ "needsSetup": boolean }`. |
| `GET` | `/public/theme` | Public | Return the active public brand, colors, fonts, text, and asset URLs. |
| `GET` | `/public/theme/assets/:file` | Public | Serve a whitelisted active-theme asset. |
| `GET` | `/config` | Authenticated | Read the runtime configuration. |
| `PUT` | `/config` | Admin or setup mode | Apply a validated configuration patch. |
| `GET` | `/config/tool-deferral` | Admin or setup mode | Read effective tool-loading and deferral settings. |
| `GET` | `/system` | Authenticated | Read running version, latest version, update availability, auto-update state, and diagnostics. |
| `GET` | `/system/readiness` | Admin or setup mode | Check chat, optional memory, platforms, plugins, webhooks, and other registered subsystems. |
| `POST` | `/system/update` | Admin or setup mode | Start the guarded in-place update. |
| `POST` | `/system/restart` | Admin or setup mode | Restart the selected daemon service. |
| `GET` | `/system/logs` | Admin | List available daemon and web log files. |
| `GET` | `/system/logs/:name` | Admin | Read a bounded tail of one log file (`?lines=`). |
| `DELETE` | `/system/logs/:name` | Admin | Delete one log file. |
| `DELETE` | `/system/logs` | Admin | Delete all log files. |
| `GET` | `/events` | Authenticated SSE | Stream core and enabled-plugin state-change events, filtered by project access and memory ownership. |
| `ALL` | `/mcp` | Authenticated | Handle a stateless MCP request using the caller's available Elowen and plugin tools. |

Web Push uses the following endpoints:

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/push/vapid-public-key` | Public | Return the VAPID public key used by browsers. |
| `POST` | `/push/subscribe` | Authenticated | Register or update the caller's push device. |
| `POST` | `/push/unsubscribe` | Authenticated | Remove one of the caller's push devices. |

## Authentication, accounts, and users

### Login and Microsoft SSO

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `POST` | `/auth/login` | Public | Verify `username` and `password`; return a bearer token, user, and token TTL. |
| `POST` | `/auth/logout` | Authenticated | Revoke the current bearer token. |
| `GET` | `/auth/sso/providers` | Public | List configured SSO providers. |
| `POST` | `/auth/sso/msteams/start` | Public | Start a Microsoft Teams SSO flow. |
| `POST` | `/auth/sso/msteams/callback` | Public | Complete a Microsoft Teams SSO flow with `flowId`, `state`, and `code`. |

Example login:

```bash
TOKEN=$(elowen api POST /auth/login '{"username":"admin","password":"your-password"}' | jq -r .token)
elowen api GET /auth/me
```

### Current-account routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/auth/me` | Read the current user profile. |
| `PATCH` | `/auth/me` | Update the current user's name, email, or default executable. |
| `POST` | `/auth/me/password` | Change the current password. |
| `POST` | `/auth/me/avatar` | Upload an avatar as multipart field `avatar`; accepted types are PNG, JPEG, WebP, and GIF, up to 2 MiB. |
| `GET` | `/auth/me/prompts` | List editable prompt templates and the caller's overrides. |
| `PUT` | `/auth/me/prompts/:name` | Save one personal prompt override. |
| `DELETE` | `/auth/me/prompts/:name` | Remove one personal prompt override. |
| `GET` | `/auth/me/cli-settings` | Read model, vision-model, compaction, reasoning, memory, communication-style, link, and instruction settings. |
| `PATCH` | `/auth/me/cli-settings` | Update those account settings. `userInstructions` is the public field; `personalityBody` is a compatibility alias. |
| `GET` | `/auth/me/terminal-settings` | Read terminal appearance settings. |
| `PATCH` | `/auth/me/terminal-settings` | Update terminal appearance settings. |
| `GET` | `/auth/me/permissions` | Read the account's tool and shell permission rules. |
| `PATCH` | `/auth/me/permissions` | Update those rules and the persisted YOLO default. |
| `GET` | `/auth/me/nav-settings` | Read the caller's navigation layout preferences. |
| `PATCH` | `/auth/me/nav-settings` | Update navigation layout preferences. |
| `GET` | `/users/:id/avatar/url` | Mint a short-lived signed avatar URL. |
| `GET` | `/users/:id/avatar` | Serve an avatar using authentication or a valid signed URL. |

### Administrator user management

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/users` | List users. Open during setup; administrator-only afterwards. |
| `POST` | `/users` | Create a user. Open during setup; administrator-only afterwards. |
| `PATCH` | `/users/:id` | Update username, profile, administrator status, executable allow-list, tool grants, disabled tools, and plugin grants. |
| `DELETE` | `/users/:id` | Delete a non-admin user after account processes and plugin-owned data are cleaned up. |
| `GET` | `/users/:id/tools` | Show the tools available to a user and their effective state. |
| `GET` | `/users/:id/stats` | Read aggregate memory count, session count, and most-used model. |
| `POST` | `/users/:id/impersonate` | Issue a token for an administrator to inspect another user's view. |
| `GET` | `/users/:id/projects` | List a user's project assignments. |
| `POST` | `/users/:id/projects` | Assign a project to a user; the JSON body contains `projectId`. |
| `DELETE` | `/users/:id/projects/:pid` | Remove a project assignment. |

## Projects and repository access

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/projects` | Authenticated | List projects visible to the caller. |
| `GET` | `/projects/summary` | Authenticated | Return the project register projection, including permitted plugin indicators and administrator member summaries. |
| `GET` | `/projects/:id/users` | Admin | List users assigned to a project. |
| `GET` | `/fs/dirs` | Admin | Browse permitted server directories for project registration (`?path=`). It returns directory names, not file contents. |
| `POST` | `/projects` | Admin | Register a project with `slug`, `path`, and optional `notes`. |
| `PATCH` | `/projects/:id` | Admin | Update a project's path, notes, or project-relative image icon. The slug is immutable. |
| `DELETE` | `/projects/:id` | Admin | Remove a project from Elowen's registry and access grants. It does not delete files on disk, and the home project cannot be removed. |
| `GET` | `/projects/:id/git` | Project access | Read the project's Git snapshot, branches, and recent commits. |

Core does not expose general file browsing or editing routes. Those are provided by enabled plugins and remain subject to the same project and path guards.

## Usage and activity

### Usage

| Method | Path | Access | Query parameters |
| --- | --- | --- | --- |
| `GET` | `/usage/by-model` | Authenticated | Optional valid ISO `from` and `to`; invalid dates are ignored. |
| `GET` | `/usage/by-day` | Authenticated | `days`, from 1 to 90; default `7`. |
| `GET` | `/usage/by-origin` | Admin | `group=user\|origin\|pair`, default `pair`; `limit` 1–500, default `50`; optional `from` and `to`. |
| `POST` | `/usage/reset` | Admin | Clear the authenticated caller's message-derived and origin usage aggregates without deleting messages. |

The usage-by-model and usage-by-day responses support private ETags and return `304 Not Modified` when the caller sends a matching `If-None-Match` header.

### Activity

| Method | Path | Query parameters | Purpose |
| --- | --- | --- | --- |
| `GET` | `/activity` | `limit` 1–500, optional `type` and `target` | Read the activity feed, scoped by project access. |
| `GET` | `/activity/presence` | — | List people currently or recently active without conversation content. |
| `GET` | `/activity/pulse` | — | Return the dashboard pulse: active people, running sub-agents, usage, surfaces, memory hits, cache ratios, and daily/monthly activity. |
| `GET` | `/activity/heatmap` | `days` 1–90; default `14` | Return hourly activity counts. |

## Brain and advisor

Brain routes operate on the authenticated user's own active conversation unless a route documents an explicit `session` parameter. A missing or disabled brain returns `503` where the route cannot provide a meaningful result.

### Status, sessions, history, and attachments

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/brain/status` | Read active-session status, model, project working directory, optional LSP state, and administrator MCP status. Use `?session=` to inspect a bound session. |
| `GET` | `/brain/rate-limits` | Read the active model's provider usage window. |
| `GET` | `/brain/rate-limits/all` | Read usage windows for all connected supported OAuth providers. |
| `GET` | `/brain/context-usage` | Read the live conversation context breakdown; use `?session=` for a specific session. |
| `POST` | `/brain/start` | Start or resume a conversation. Use `fresh: true` for a new conversation. |
| `GET` | `/brain/sessions` | List the caller's conversations. Add `limit` and/or `offset` for a `{ items, total, hasMore }` response; without them the legacy array response is retained. |
| `GET` | `/brain/managed-sessions` | Administrator view of managed conversations, including platform sessions. |
| `DELETE` | `/brain/managed-sessions` | Administrator bulk deletion; use `?scope=all` for the cross-account register. |
| `DELETE` | `/brain/managed-sessions/:id` | Administrator deletion of one managed conversation. |
| `GET` | `/brain/messages` | Read active history, or use `?session=` for an explicit session. Supports `limit` and `before` pagination. Administrators may read foreign sessions but cannot send to them through this route. |
| `GET` | `/brain/search` | Search the caller's conversation messages with `?q=`. Queries shorter than two characters return an empty result. |
| `PATCH` | `/brain/sessions/:id` | Rename an owned conversation with `{ "title": "…" }`. |
| `DELETE` | `/brain/sessions/:id` | Delete an owned conversation. |
| `POST` | `/brain/sessions/:id/fork` | Create a new conversation seeded with an owned conversation's history. |
| `GET` | `/brain/sessions/:id/export` | Download an owned conversation as HTML by default or JSONL with `?format=jsonl`. |
| `GET` | `/brain/chat-images/:file` | Serve an image attachment referenced by an owned message. |
| `GET` | `/brain/chat-files/:file` | Download a non-image attachment referenced by an owned message. |
| `GET` | `/brain/images/:file` | Serve a generated PNG from the image-generation or image-edit plugin data directory. |
| `POST` | `/brain/uploads` | Stream one file into a permitted project. Pass the original name as `?name=`; the response identifies the stored path and project. |

### Sending messages and the live stream

Send a message with `POST /brain/send`:

```http
POST /brain/send
Authorization: Bearer <token>
Content-Type: application/json

{
  "text": "Review the authentication changes",
  "mode": "plan",
  "surface": "cli"
}
```

`mode` is `build`, `plan`, or `workflow`. Up to four image attachments can be supplied in `images`; each contains base64 `data` and one of `image/png`, `image/jpeg`, `image/gif`, or `image/webp` as `mimeType`. `cwd`, `session`, `client`, `generation`, and `display` are optional client/session fields.

The endpoint returns HTTP `202` after the turn has been admitted. It does not wait for the model response. Consume the result from `GET /brain/stream`:

```text
GET /brain/stream?heartbeat=1
Accept: text/event-stream
```

The stream is Server-Sent Events. By default it follows the active conversation; `?session=<id>` selects an explicit session. A drill-in client can request `snapshot=1` with a session to receive an initial `snapshot` event and then live events. `?history=<n>` limits that snapshot's history window. `?client=<id>&generation=<n>` binds client lifecycle operations. `?heartbeat=1` emits a named `heartbeat` event every 30 seconds; otherwise keep-alives are SSE comments.

The global `GET /events` stream is separate from the conversation stream. It reports application state changes, while `/brain/stream` reports brain events and transcript updates.

### Turn controls, queue, goals, and sub-agents

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/brain/abort` | Abort the active or `session`-selected turn. |
| `POST` | `/brain/interrupt-queued` | Interrupt the active turn and promote the oldest queued message. |
| `POST` | `/brain/session/stop` | Release a client binding and stop/dispose a session when appropriate; `detachOnly` is used by closing web clients. |
| `POST` | `/brain/visibility` | Report whether a client window is hidden or visible. |
| `POST` | `/brain/model` | Switch the selected conversation to a configured provider/model. |
| `POST` | `/brain/think` | Set reasoning effort for the conversation and account default. Body: `{ "level": "…", "session"?: "…" }`. |
| `POST` | `/brain/fast` | Enable or disable the provider priority service tier for a conversation. |
| `POST` | `/brain/yolo` | Enable or disable the conversation-scoped YOLO override. Deny rules still apply. |
| `POST` | `/brain/cwd` | Record a validated working-directory change. |
| `POST` | `/brain/compact` | Compact conversation context, optionally with an `instruction`. |
| `GET` | `/brain/queue` | Read pending messages for the active or selected session. |
| `DELETE` | `/brain/queue/:id` | Clear pending queued messages; the path ID is retained for wire compatibility. |
| `POST` | `/brain/queue/recall` | Pop and return the last queued message. |
| `GET` | `/brain/goal` | Read the active or selected conversation goal. |
| `POST` | `/brain/goal` | Set a goal. `turnBudget` is clamped to 1–50 and `draft` enables draft mode. |
| `POST` | `/brain/goal/action` | Run `?action=pause`, `?action=resume`, or `?action=clear`. |
| `POST` | `/brain/subgoal` | Add, remove, or clear sub-goals with a body action of `add`, `remove`, or `clear`. |
| `POST` | `/brain/answer` | Answer a pending `AskUserQuestion` using its event `id` and an `answers` array. |
| `POST` | `/brain/subagent/send` | Send a message to an owned delegated sub-agent session. |
| `POST` | `/brain/subagents/background` | Detach foreground delegated sub-agents while leaving them running. |
| `POST` | `/brain/commands/background` | Detach a foreground shell command without killing it. |
| `POST` | `/brain/commands/kill` | Kill foreground shell commands for the conversation. |
| `POST` | `/brain/workflows/background` | Detach a foreground sub-agent workflow while leaving it running. |

`GET /brain/commands?surface=web|cli|discord|telegram|whatsapp|msteams` returns the slash-command catalog for that surface. `POST /brain/command` executes only commands that the server dispatches; client-side pickers and informational commands must use their dedicated route or local implementation.

### Terminal and processes

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `POST` | `/brain/terminal` | Admin | Open or reattach an interactive `elowen chat` terminal for an owned conversation. |
| `GET` | `/brain/processes` | Process owner | List the caller's background shell processes; use `?session=` to select a conversation. |
| `GET` | `/brain/processes/:id/output` | Process owner | Read one process output buffer. |
| `DELETE` | `/brain/processes/:id` | Process owner | Kill one background process. |
| `POST` | `/brain/context` | Admin | Bind an owned conversation into a platform channel target. Body: `{ "channel": "…", "session": "…" }`. |

The WebSocket endpoint is `GET /ws/terminal`. A client first obtains a single-use ticket from the terminal plugin's authenticated API route, then uses the ticket for the upgrade. The old core `/sessions/:name/ws-ticket` route is no longer a core endpoint.

### Providers and OAuth

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/brain/models` | Authenticated | List configured models permitted for the caller. |
| `POST` | `/brain/providers/probe` | Admin or setup mode | Probe an OpenAI-compatible provider's `/models` endpoint. |
| `GET` | `/brain/providers/hosted-tool-search/status` | Admin or setup mode | Read verification status for Azure OpenAI hosted tool search. |
| `POST` | `/brain/providers/hosted-tool-search/probe` | Admin or setup mode | Verify one configured Azure OpenAI hosted tool-search model. |
| `POST` | `/brain/test` | Admin or setup mode | Run one non-streaming provider smoke test; provider failures are returned as `{ "ok": false, "error": "…" }`. |
| `GET` | `/brain/oauth/status` | Admin or setup mode | Show connection status for supported built-in OAuth providers. |
| `GET` | `/brain/oauth/:type/catalog` | Admin or setup mode | List the built-in model catalog for an OAuth provider. |
| `POST` | `/brain/oauth/:type/start` | Admin or setup mode | Start an OAuth flow; `?method=` selects the provider's method. |
| `GET` | `/brain/oauth/flow/:id` | Admin or setup mode | Poll one OAuth flow. |
| `POST` | `/brain/oauth/flow/:id/input` | Admin or setup mode | Submit input requested by a flow. |
| `DELETE` | `/brain/oauth/:type` | Admin or setup mode | Disconnect an OAuth provider. |

### Diagnostic routes

`/brain/debug/*` is an administrator-only, private, non-cacheable diagnostic surface. It includes session, request, segment, raw-request, and legacy-transcript inspection routes. It is intended for debugging the daemon, not for normal chat clients.

## Memory

Memory is private to the authenticated account. Core memory works without embeddings; semantic search and re-indexing use embeddings when configured.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/memory` | Own account | List memories. Supports `status`, `kind`, `categoryId`, `limit`, and `offset`; `q` performs semantic search and falls back to keyword search when embeddings are unavailable. |
| `POST` | `/memory` | Own account | Create a memory. |
| `GET` | `/memory/:id` | Own account | Read one memory. |
| `PATCH` | `/memory/:id` | Own account | Update one memory. |
| `DELETE` | `/memory/:id` | Own account | Soft-delete one memory. |
| `POST` | `/memory/:id/restore` | Own account | Restore a soft-deleted memory. |
| `DELETE` | `/memory/:id/purge` | Own account | Permanently delete one memory. |
| `PUT` | `/memory/:id/category` | Own account | Assign or clear a category. |
| `GET` | `/memory/:id/events` | Own account | Read one memory's audit history. |
| `GET` | `/memory/:id/vitality-history` | Own account | Read vitality history; `days` defaults to `30` and is capped at `365`. |
| `GET` | `/memory/events` | Own account | Read the account's memory audit feed; optional `limit`. |
| `POST` | `/memory/merge` | Own account | Merge source memory IDs into a new memory; sources are soft-deleted. |
| `POST` | `/memory/purge` | Own account | Permanently delete a batch of memory IDs. |
| `POST` | `/memory/empty-trash` | Own account | Permanently delete all soft-deleted memories. |
| `POST` | `/memory/retrieve` | Own account | Inspect retrieval ranking for a query. |
| `POST` | `/memory/reindex` | Own account | Re-embed pending or stale memories; one request processes at most 100. |
| `GET` | `/memory/categories` | Own account | List owned categories. |
| `POST` | `/memory/categories` | Own account | Create a category, optionally linked to an accessible project. |
| `PATCH` | `/memory/categories/:cid` | Own account | Update a category. |
| `DELETE` | `/memory/categories/:cid` | Own account | Delete a category and clear references from its memories. |
| `POST` | `/memory/categories/suggest-icon` | Own account | Suggest a category icon. |
| `GET` | `/memory/embedding` | Authenticated | Read workspace embedding configuration and its computed `configured` flag. |
| `PUT` | `/memory/embedding` | Admin or setup mode | Update workspace embedding configuration. |
| `POST` | `/memory/embedding/test` | Admin or setup mode | Test the configured embedding provider. |
| `GET` | `/memory/categorization` | Authenticated | Read workspace categorization configuration and its `configured` flag. |
| `PUT` | `/memory/categorization` | Admin or setup mode | Update workspace categorization configuration. |
| `POST` | `/memory/reclassify` | Own account | Reclassify the caller's active memories. |

A foreign or unknown memory/category ID is normally reported as `404`, so IDs cannot be used to inspect another account's data.

## Plugins, webhooks, and integrations

### Plugin platform routes

The core plugin administration surface is under `/plugins` and is administrator-only unless noted.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/plugins` | List discovered plugins, versions, enabled/removed state, capabilities, and health. |
| `GET` | `/plugins/runtime` | Report the contributions actually registered by the live plugin registry. |
| `GET` | `/plugins/tools` | List built-in and plugin tools. |
| `GET` | `/plugins/destinations` | List notification destinations from enabled platform plugins. |
| `GET` | `/plugins/marketplace` | Read the curated marketplace catalog; `?refresh=1` refreshes it. |
| `POST` | `/plugins/marketplace/:name/install` | Install a marketplace plugin, optionally enabling it after grant consent. |
| `POST` | `/plugins/marketplace/:name/update` | Update a marketplace plugin. |
| `GET` | `/plugins/:name` | Read one plugin manifest, configuration schema, capabilities, and data summary. |
| `PATCH` | `/plugins/:name` | Enable or disable a plugin. Enabling may require the manifest's declared grant consent. |
| `DELETE` | `/plugins/:name` | Uninstall a marketplace plugin or soft-remove a bundled plugin. |
| `POST` | `/plugins/:name/restore` | Restore a soft-removed bundled plugin. |
| `PATCH` | `/plugins/:name/config` | Update instance-wide plugin configuration. |
| `GET` | `/plugins/:name/contributions` | Read one plugin's live contribution report. |
| `GET` | `/plugins/:name/logs` | Read one plugin's bounded log tail and health. |
| `GET` | `/plugins/:name/hook-executions` | Read recent mutating-hook execution records. |
| `POST` | `/plugins/:name/data/clear` | Permanently clear the plugin's own data directory. |
| `GET` | `/plugins/:name/icon` | Serve a plugin icon; this route is not administrator-only. |
| `GET` | `/plugins/user-config` | List per-account configuration forms available to the caller. |
| `PATCH` | `/plugins/:name/user-config` | Save the caller's own per-plugin configuration. |
| `GET` | `/plugins/ui` | Return the authenticated plugin UI bundle listing. |
| `GET` | `/plugins/:name/web/:file` | Serve a plugin's web asset. |

Plugin API handlers are resolved from the live registry on every request:

- Namespaced routes use `/plugins/:name/api/*`.
- A plugin may declare a root mount in its manifest; root-mounted routes are resolved after core routes, so core routes win on conflicts.
- Plugin routes declare their access level. The dispatcher enforces administrator access and, for `userGrantable` plugins, the caller's plugin grant.
- Buffered plugin API request bodies are capped at 4 MiB. Plugin handlers may also return SSE responses.

### Webhooks

`/hooks/*` is public at the daemon authentication layer because external providers cannot send an Elowen bearer token. The matching plugin authenticates and validates each webhook request. Webhook bodies are capped at 1 MiB. Unknown mounts return `404`; handler failures return `{ "error": "hook handler failed" }` with HTTP `500`.

## Implementation notes

Core route registration is centralized in `src/api/routes/index.ts`. The route modules are the authoritative list for the current daemon; plugin manifests are authoritative for plugin-owned API and webhook mounts. For a new endpoint, update the owning route module and its request schema, then document the public contract here.
