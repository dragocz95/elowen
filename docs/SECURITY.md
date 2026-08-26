# Security

This page describes the security boundaries an operator must understand when exposing or administering an Elowen instance. The primary enforcement points are the daemon authentication middleware, project tenancy checks, per-account tool/plugin policy, and the filesystem path guard.

## Deployment boundary

- The daemon listens on `127.0.0.1:4400` by default. The web app listens on `:4500`.
- `ELOWEN_HOST` can deliberately expose the daemon, for example for a deployment without a local reverse proxy. Do not expose the daemon directly to an untrusted network: a bearer token can authorize interactive work and delegated sub-agents.
- Persistent state is outside the package at `~/.config/elowen` by default. `ELOWEN_DB` changes the SQLite path and `ELOWEN_LOG_DIR` changes the log directory. Protect the state directory and database as daemon-owned secrets.
- The default HTTP middleware enables CORS for all origins. Network exposure should therefore be controlled by the reverse proxy, firewall, or private network rather than by assuming browser-origin restrictions.

## Authentication

After the first local user exists, requests require a bearer token except for the explicitly public routes below:

```http
Authorization: Bearer <token>
```

Tokens are accepted from the `Authorization` header only. Tokens in query parameters are rejected; this prevents credentials from leaking into URLs, access logs, referrers, and proxy caches.

### Public routes

The daemon auth layer allows these requests without a bearer token:

- `GET /health`
- `/setup` while the instance has no users
- `POST /auth/login`
- `GET /auth/sso/providers`
- `POST /auth/sso/msteams/start` and `/auth/sso/msteams/callback`
- `GET /push/vapid-public-key`
- `GET /public/theme` and whitelisted theme assets
- `GET /ws/terminal` — the WebSocket handler requires a single-use ticket minted by an authenticated request
- signed `GET /users/:id/avatar` requests
- `/hooks/*` plugin webhook mounts; each receiving plugin authenticates its own webhook request

Setup mode is intentionally open until the first user is created so the onboarding flow can create the first administrator. Once a user exists, normal authentication is enforced again.

### Token lifetime and storage

- `security.tokenTtlDays` controls token lifetime. The default is **30 days**; values below one day are not accepted.
- The web UI stores the token in the httpOnly `elowen_session` cookie. The browser talks to the same-origin web BFF; the BFF translates the cookie into a daemon bearer header. Mutating BFF requests also require a same-origin `Origin` when one is present. The cookie is `SameSite=Lax` and is marked `Secure` on HTTPS deployments.
- `elowen login` caches the token at `~/.config/elowen/cli.json` with mode `0600`. `ELOWEN_TOKEN` overrides the cached token and `ELOWEN_URL` overrides the daemon URL.
- `advisor` and `terminal` are stored session categories used for separate revocation. The effective API principal currently has `full` access; there is no current `agent` token scope.

### Passwords and SSO

- Passwords must contain at least 8 characters.
- Passwords are stored as scrypt hashes with a random 16-byte salt and compared in constant time.
- Change a password through `POST /auth/me/password`; the current password is required.
- Microsoft SSO identities are tenant-scoped. An external identity is keyed by provider, tenant, and subject, and one external identity can bind to only one local account. Existing-account linking is separate from account provisioning and replacement must be explicit.
- External provisioning cannot create the first administrator. SSO provisioning is disabled unless tenant provisioning is configured.

## Login and client-origin protection

Password login and Microsoft SSO share an in-memory fixed-window limiter: 10 attempts per five minutes per resolved origin. A successful login clears that origin's counter, and counters disappear when the daemon restarts.

Origin resolution is centralized in `src/api/clientIp.ts`:

1. `x-real-ip` is preferred. The installed nginx configuration overwrites it with the peer address.
2. `x-forwarded-for` is only a last-resort hint and is always treated as untrusted.
3. With no forwarding header, the origin is `local`.
4. `security.trustProxy` controls whether `x-real-ip` is trusted. It defaults to `true` for the installed nginx topology; set it appropriately when running behind a different proxy or without one.

The web BFF forwards `x-real-ip` but deliberately does not forward browser-supplied `x-forwarded-for`, `forwarded`, or `authorization` headers.

## Accounts, roles, and tenancy

The administrator flag is the explicit `users.is_admin` column. It is not inferred from the first user, a username, or a chat-room role.

- Administrators have all-project access and can manage users, projects, configuration, and account grants.
- Non-administrators are limited to their assigned projects. Project-scoped routes filter every result by that assignment.
- `/activity`, `/events`, and `/usage` have a coarse gate that requires an administrator or at least one assigned project; the route-level project filter remains the authoritative data boundary.
- A user with no positive tool grant receives no grant-controlled plugin tools. An explicit `disabled_tools` deny-list still applies to administrators.
- Unknown account IDs resolve to an empty tool grant rather than unrestricted access.

### Per-account plugin grants

A plugin whose manifest sets `userGrantable` is deny-by-default for non-administrators. The administrator grants it to an account through the users UI. An empty `granted_plugins` list means that no such plugin is granted; administrators bypass the positive grant check.

The same access predicate controls plugin routes, UI listings, runtime access, tools, and skills. A hidden menu is not the security boundary: the API and tool resolver enforce the grant as well.

## Delegated sub-agents and workflows

Delegation captures the caller's current access into an immutable child scope, including:

- administrator and project access;
- owner authority;
- tool allow/deny policy;
- the permission boundary;
- read-only and plan-mode origin;
- spawning principal and contribution account.

A child can only narrow the caller's tools. `read_only` removes write tools and applies the non-destructive shell boundary, but it is **not a sandbox**: shell redirection can still write to paths the shell is otherwise allowed to reach. A child cannot be continued if its stored scope exceeds the caller's current projects, authority, tool grants, or permission boundary.

`write_access: true` can promote only a child that was explicitly requested as read-only, was spawned by the same principal, and still fits inside the caller's current access. It cannot override a read-only boundary imposed by plan mode or the agent definition. Workflow nodes inherit the effective boundary of the node that creates them.

Delegated children do not receive the parent account's personal memory identity.

## Filesystem and terminal boundaries

`src/plugins/pathGuard.ts` is the common filesystem boundary for file and terminal tools:

- Non-administrator sessions can access only their accessible project roots.
- Paths are resolved through symlinks before containment is checked, including the closest existing ancestor for new paths. A symlink cannot escape an allowed root.
- The default working directory is the turn's project directory, then the first allowed root.
- A session may access its own plan file and its own tool-result spill directory as narrow, session-specific exceptions.
- Administrator all-access sessions are the exception and may resolve arbitrary filesystem paths.

The terminal plugin is separately grantable to accounts. Granting the terminal plugin does not grant an ordinary account unrestricted host access: the terminal sandbox confines non-operators to the account's permitted roots and home area, and unavailable sandboxing fails closed.

Plan mode keeps the full tool list advertised for prompt-cache stability, but execution-time policy blocks write tools except for the session's own plan file. Its Bash rules are non-destructive restrictions, not a filesystem sandbox; shell redirection can still write where the shell boundary permits it.

## Plugins, MCP, and secrets

Fresh installs enable the core plugin set `files`, `sandbox`, `terminal`, `askuser`, `runtime-context`, `subagent`, `elowen-docs`, `statusline`, and `mcp`. Plugin access is still subject to the manifest's grant policy and the account's tool policy.

- Plugin secret fields are write-only. API responses return whether a secret is set, not its value.
- Brain provider API keys are stripped from public configuration views and represented by `apiKeySet: boolean`.
- MCP servers in personal scope belong to the account. Instance scope is shared; local-process (`stdio`) servers are restricted to the instance operator.
- Plugin webhooks under `/hooks/*` are public at the daemon auth layer because the owning plugin must validate the external provider's signature or token.

## GitHub integration

GitHub repository operations always begin from an accessible Elowen `projectId`; tools do not accept arbitrary repository coordinates as an escape hatch.

- The connected GitHub credential is stored in the per-account vault as an opaque `cli-token`. There is no refresh-token flow; a 401 marks the account `reconnect_required`.
- Browser responses expose connection metadata, never the GitHub token.
- Publishing consumes the caller's active Sandbox workspace. It requires a committed `HEAD` and a generated Elowen branch; GitHub does not create or remove worktrees.
- Push uses a one-shot credential broker. The token is not placed in process arguments, environment variables, the remote URL, or persistent Git configuration. Force-push, automatic branch deletion, auto-merge, and blind retries after an unknown mutation outcome are unavailable.
- Publishing, pull-request creation, reviews, and merges require an interactive confirmation in a verified conversation. Delegated, scheduled, and unattended contexts are read-only.
- Merge checks include the exact expected head SHA, an open non-draft PR, successful checks, no current changes-requested review, and a repository-supported merge method.

## Web Push

- VAPID keys are generated on first boot and persisted in the daemon configuration. The public key is intentionally available at `GET /push/vapid-public-key`; the private key remains daemon-side.
- Subscribe and unsubscribe requests are authenticated and scoped to the current account. An account can remove only its own endpoint.
- Push endpoints returning HTTP 404 or 410 are pruned so dead subscriptions are not retried indefinitely.

## Operational checklist

Before exposing an instance beyond localhost:

1. Put the daemon behind a trusted reverse proxy or private network.
2. Set `security.trustProxy` to match the actual proxy topology.
3. Protect `~/.config/elowen` (or the paths selected by `ELOWEN_DB` and `ELOWEN_LOG_DIR`) from other users on the host.
4. Grant `terminal` and other `userGrantable` plugins only to accounts that need them.
5. Review each account's disabled tools and project assignments.
6. Keep the web UI and daemon on HTTPS when used remotely so the session cookie is `Secure` in transit.
