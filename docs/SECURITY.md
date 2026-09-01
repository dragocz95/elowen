# Security

This page describes the security boundaries an operator must understand when exposing or administering an Elowen instance. The primary enforcement points are daemon authentication, account and project tenancy, per-turn tool policy, plugin grants, delegated execution scopes, and the filesystem path guard.

## Deployment boundary

- The daemon listens on `127.0.0.1:4400` by default. The web app listens on `:4500`.
- `ELOWEN_HOST` can deliberately expose the daemon. Do not expose it directly to an untrusted network: a bearer token can authorize interactive work and start delegated sub-agents.
- Persistent state is outside the package at `~/.config/elowen` by default. `ELOWEN_DB` changes the SQLite path and `ELOWEN_LOG_DIR` changes the log directory. Protect these paths and their backups as secrets.
- The default HTTP middleware allows all CORS origins. Use a trusted reverse proxy, firewall, or private network for exposure; do not rely on browser-origin restrictions as the network boundary.

## Authentication

After the first local user exists, requests require a bearer token except for the explicitly public routes below:

```http
Authorization: Bearer <token>
```

Tokens are accepted from the `Authorization` header only. Query-string tokens are rejected so credentials do not enter URLs, access logs, referrers, or proxy caches.

### Public routes

The daemon authentication layer allows these requests without a bearer token:

- `GET /health`
- `/setup` while the instance has no users
- `POST /auth/login`
- `GET /auth/sso/providers`
- `POST /auth/sso/msteams/start` and `/auth/sso/msteams/callback`
- `GET /push/vapid-public-key`
- `GET /public/theme` and whitelisted theme assets
- signed `GET /users/:id/avatar` requests
- `/hooks/*` plugin webhook mounts; each receiving plugin validates its own provider signature or token

Setup mode is open only until the first user is created so onboarding can create the first administrator. Authentication is then enforced again.

### Token lifetime and storage

- `security.tokenTtlDays` controls token lifetime. The default is **30 days**; values below one day are rejected.
- The web UI stores the token in the httpOnly `elowen_session` cookie. The same-origin web BFF converts it to a daemon bearer header. Mutating BFF requests require a same-origin `Origin` when one is present. The cookie is `SameSite=Lax` and is `Secure` on HTTPS deployments.
- `elowen login` caches a full-scope token in `~/.config/elowen/cli.json` with mode `0600`. `ELOWEN_TOKEN` overrides the cached token and `ELOWEN_URL` overrides the daemon URL.
- `advisor` and `terminal` are stored token categories for separate revocation. The API principal currently receives full API access; there is no `agent` token scope. Token categories do not replace turn-level project, plugin, or tool policy.

### Passwords and Microsoft SSO

- Passwords require at least 8 characters and are stored as scrypt hashes with a random 16-byte salt, compared in constant time.
- Change a password through `POST /auth/me/password`; the current password is required.
- Microsoft SSO uses tenant-scoped OIDC identities. An external identity is keyed by provider, tenant, and subject, and one external identity can bind to only one local account.
- Existing-account linking is separate from provisioning and replacement must be explicit. External provisioning cannot create the first administrator and is disabled unless tenant provisioning is configured.
- SSO `next` redirects are restricted to local paths; external or protocol-relative redirects are rejected.

## Login rate limiting and proxy/IP handling

Password login and Microsoft SSO share an in-memory fixed-window limiter: 10 attempts per five minutes per resolved origin. A successful login clears that origin's counter; counters disappear when the daemon restarts.

Origin resolution is centralized in `src/api/clientIp.ts`:

1. `x-real-ip` is preferred. The installed nginx configuration overwrites it with the peer address.
2. `x-forwarded-for` is only a last-resort hint and is always treated as untrusted.
3. With no forwarding header, the origin is `local`.
4. `security.trustProxy` controls whether `x-real-ip` is trusted. It defaults to `true` for the installed nginx topology; set it to `false` unless the configured proxy overwrites that header reliably.

The web BFF forwards `x-real-ip` but does not forward browser-supplied `x-forwarded-for`, `forwarded`, or `authorization` headers. Internal work such as cron and recovery is attributed as `internal`; platform turns use a platform identity rather than inventing an IP.

## Accounts, identities, roles, and tenancy

The administrator flag is the explicit `users.is_admin` column. It is not inferred from the first user, a username, or a chat-room role.

- Administrators have all-project access and can manage users, projects, configuration, and account grants.
- Non-administrators are limited to their assigned projects. Project-scoped routes filter every result by that assignment; revocations narrow live policy immediately, while a new grant waits for a new turn/session policy.
- `/activity`, `/events`, and `/usage` have a coarse gate requiring an administrator or at least one assigned project. Route-level project filtering remains the authoritative data boundary.
- A verified account identity is distinct from `owner`: `owner` means the configured instance operator or an account with the administrator flag. A foreign platform member with a room role that looks administrative does not acquire owner-only access.

Turn identities distinguish four surfaces:

- `own`: the account's authenticated Elowen web or CLI chat;
- `direct`: a one-to-one platform chat with one verified linked account;
- `shared`: a platform room readable by multiple people;
- `delegated`: a sub-agent turn with no conversation of its own.

A shared room does not become a private account context merely because one sender is linked. Platform display names and role IDs are not authentication. Account-owned state and actions must use the verified linked account or an explicit contribution owner, not an arbitrary room sender.

## Per-account plugin and tool grants

A plugin whose manifest sets `userGrantable` is deny-by-default for non-administrators. An administrator grants it to an account through the users UI. An empty `granted_plugins` list means that no grantable plugin is granted; administrators bypass only this positive grant check.

The same access predicate controls plugin routes, UI listings, runtime access, tools, MCP tools, and skills. A hidden menu is not a security boundary. An explicit `disabled_tools` deny-list still applies to administrators, and unknown account IDs resolve to an empty grant rather than unrestricted access.

Tool policy is evaluated per turn:

- `allow` restricts the tool set; `deny` removes tools after the allow-list is applied.
- Shared rooms may compose personal tools from multiple linked accounts, but dispatch is bound to the current contribution owner; one person's personal MCP server is not silently exposed to another.
- `AskUserQuestion` requires an interactive prompt turn and is denied in unattended delegated work.
- Owner-only surfaces such as instance controls, raw Discord administration, instance MCP, and local-process MCP servers require `identity.owner`, not merely `admin` or a platform role.

## Delegated sub-agents and workflows

When a child is spawned, Elowen persists an immutable execution scope containing the caller's current:

- administrator and project access;
- owner authority;
- allow/deny tool policy;
- granular permission boundary;
- read-only or plan-mode origin;
- spawning principal, settings account, and contribution account;
- optional Sandbox workspace reference.

Delegation can only narrow access. A `read_only` child uses a host-defined read-only tool set and a non-destructive shell boundary. It is **not a filesystem sandbox**: shell redirection can still write wherever that shell boundary permits. In Plan mode, the `Write` and `Edit` file tools are clamped to the session plan file; the shell guardrail is not write-proof.

A stored child cannot be continued if its scope exceeds the current caller's projects, authority, tool grants, permission boundary, account context, or workspace. `write_access: true` can promote only a read-only child explicitly requested by the same principal; it cannot lift a restriction imposed by plan mode or the agent definition. Workflow nodes inherit the effective boundary of the node that creates them.

Delegated children do not receive the parent's personal memory identity. They use the captured contribution/settings context without becoming that account for private-memory operations. Scheduled, detached, and other unattended turns have no live user elicitor and cannot use interactive approval to widen access.

## Filesystem, terminal, and workspace boundaries

`src/plugins/pathGuard.ts` is the common filesystem boundary for file and terminal tools:

- Non-administrator sessions can access only their currently accessible project roots.
- Paths are resolved through symlinks before containment is checked, including the closest existing ancestor for new paths. A symlink cannot escape an allowed root.
- The default working directory is the turn's bound project directory, then the first allowed root.
- A session may access only its own plan file and its own tool-result spill directory as narrow, session-specific exceptions.
- Administrator all-access sessions may resolve arbitrary filesystem paths, except when an explicit workspace is requested.

A Sandbox workspace is identified by the durable `(workspaceId, projectId)` ownership tuple. The host resolves the canonical path through the Sandbox plugin immediately before use and refuses stale, foreign, orphaned, path-mismatched, or inaccessible workspaces. A workspace-scoped child cannot switch to a sibling worktree, and workspace removal remains blocked while an execution lease is alive.

The terminal plugin is separately grantable. Fresh configuration confines non-operator commands with bubblewrap to permitted roots and account HOME, failing closed when confinement is required but unavailable. An operator can set `sandbox.confineNonOperators` to `false`, which deliberately lets granted non-operators run foreground and background commands directly on the host; workspace-scoped and plugin-forced confined execution remain confined.

## Plugins, MCP, and secrets

Fresh installs enable the core plugin set `files`, `sandbox`, `terminal`, `askuser`, `runtime-context`, `subagent`, `elowen-docs`, `statusline`, and `mcp`. Actual access remains subject to manifest capabilities, per-account grants, per-turn policy, and owner checks.

- Plugin secret fields are write-only. API responses expose whether a secret is set, not its value.
- Plugin secrets are encrypted in the database and require the matching `plugin-secrets.key`; a missing or mismatched key makes the vault unavailable rather than silently returning plaintext or stale values.
- Brain provider API keys are stripped from public configuration views and represented by `apiKeySet: boolean`.
- Brain OAuth credentials are stored by Elowen's `FileCredentialStore` in `<dataDir>/brain/auth.json`, refreshed through the provider runtime, and are not static API keys in Elowen provider configuration. OAuth connection management routes are administrator-only; disconnecting or replacing a credential changes what all configured turns using that instance provider can use.
- OAuth credential reads are fresh across daemon and delegated runner processes, while writes are serialized and fenced to prevent a stalled process from overwriting a rotated credential.
- MCP servers in personal scope belong to the account. Instance scope is shared; local-process (`stdio`) servers require instance-owner authority because they can see the host environment outside ordinary path-view enforcement.
- Plugin webhooks under `/hooks/*` are public at the daemon auth layer because the owning plugin must authenticate the external provider request.

## External publication and privileged actions

External writes are separate from local file access and must not be inferred from project access alone.

- GitHub operations begin from an accessible Elowen `projectId`; callers cannot supply arbitrary repository coordinates as an escape hatch.
- A connected GitHub credential is stored in the per-account encrypted vault as an opaque `cli-token`. There is no refresh-token flow; a 401 marks the account `reconnect_required`. Browser responses expose connection metadata, never the token.
- GitHub publishing consumes the caller's active Sandbox workspace. It requires a committed `HEAD` and an Elowen-generated branch; GitHub does not create or remove worktrees.
- The one-shot push broker keeps the credential out of process arguments, environment variables, remote URLs, and persistent Git configuration. Force-push, automatic branch deletion, auto-merge, and blind retries after an unknown mutation outcome are unavailable.
- GitHub publishing, pull-request creation, reviews, and merges require interactive confirmation in a verified conversation. Delegated, scheduled, and unattended contexts cannot publish or approve these actions.
- Merge checks include the exact expected head SHA, an open non-draft PR, successful checks, no current changes-requested review, and a repository-supported merge method.
- The published-sites gateway is a core-owned privileged boundary. The plugin supplies only validated site identifiers and gateway credentials; it cannot supply shell commands, system paths, upstreams, nginx fragments, certificates, or certbot arguments. Runtime sockets are created and sealed by the core/helper boundary.

## Web Push

- VAPID keys are generated on first boot and persisted in daemon configuration. The public key is intentionally available at `GET /push/vapid-public-key`; the private key remains daemon-side.
- Subscribe and unsubscribe requests are authenticated and scoped to the current account. An account can remove only its own endpoint.
- Push endpoints returning HTTP 404 or 410 are pruned so dead subscriptions are not retried indefinitely.

## Operational checklist

Before exposing an instance beyond localhost:

1. Put the daemon behind a trusted reverse proxy or private network.
2. Set `security.trustProxy` to match the actual proxy topology.
3. Protect `~/.config/elowen` (or the paths selected by `ELOWEN_DB` and `ELOWEN_LOG_DIR`) and the plugin-secret key from other users on the host.
4. Grant `terminal`, MCP-backed plugins, and other `userGrantable` plugins only to accounts that need them.
5. Review each account's disabled tools, plugin grants, and project assignments.
6. Keep the web UI and daemon on HTTPS when used remotely so the session cookie is `Secure` in transit.
7. Treat connected OAuth and GitHub credentials as instance/account secrets and reconnect them after restoring a database without its matching key material.
