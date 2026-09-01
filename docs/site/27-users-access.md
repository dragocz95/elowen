---
title: Users & Access
slug: users-access
order: 27
eyebrow: Administration
group: Administration
---

# Users & Access

Elowen uses account-level access control. An administrator manages users, roles,
project assignments, model access, plugin grants, and individual tool access from
the **Users** page (`/users`). Each account also has its own permission rules for
approvals and unattended runs.

## Authentication

After the first account is created, protected API routes require a bearer token:

```http
Authorization: Bearer <token>
```

The daemon returns a token from `POST /auth/login`. The web UI does not expose that
token to browser JavaScript. The UI uses an httpOnly session cookie with a same-origin
backend-for-frontend proxy, which adds the bearer token on the server side.

The following entry points are public or have their own authentication mechanism:

- `GET /health` and the first-run `GET /setup` check.
- `POST /auth/login` and the Microsoft SSO discovery/start/callback routes.
- Theme assets, the Web Push public key, and signed avatar URLs.
- Plugin webhook mounts under `/hooks/`, which authenticate their own provider-specific request.

Public does not mean unrestricted: each route still validates its own input or
credential. Before the first user exists, setup mode is open so onboarding can create
the first administrator. Authentication is enforced again as soon as that account
exists.

### Token lifetime and CLI credentials

Login tokens expire after **30 days by default**. An administrator can change the
minimum-one-day setting under **Settings → System** (`security.tokenTtlDays`).

The CLI stores its token in `~/.config/elowen/cli.json`. Use these environment
variables when needed:

- `ELOWEN_TOKEN` overrides the cached token.
- `ELOWEN_URL` overrides the daemon URL.

```bash
elowen login
elowen chat
elowen run "Summarize the current project"
```

Login attempts are limited to **10 attempts per five minutes per IP**. Passwords must
be at least **8 characters**, and changing a password requires the current password.
For unattended first-boot setup, provide `ELOWEN_BOOTSTRAP_USER` and
`ELOWEN_BOOTSTRAP_PASS` before starting the daemon.

## Roles and instance authority

Elowen has two account roles:

- **Admin** — can manage users, projects, configuration, and account grants, and has access to all projects.
- **Member** — can work only in projects explicitly assigned to that account.

The runtime also exposes an **instance operator** (called `owner` in turn identity). It is the earliest-created
administrator and is used as the fallback anchor for some platform conversations. It is not a third account role:
every account with `users.is_admin = true` is treated as an instance operator for owner-gated capabilities.
An administrator therefore does not need a separate owner grant. A platform room role or an `admin`-like channel
policy is not sufficient; instance authority comes from the linked Elowen account.

The Users page is administrator-only. A member who opens it directly receives an access-denied view, and the API
returns `403`.

## Create and manage accounts

Open **Users** in the sidebar and select **New user**. Enter a username and password;
the password must satisfy the eight-character minimum.

Select a user to open the detail pane. Administrators can:

- edit the user's display name and username;
- promote or demote the account between Admin and Member;
- assign projects;
- restrict available models;
- grant user-grantable plugins;
- manage the account's plugin-tool allow-list and explicit disabled-tool deny-list;
- impersonate the account for support or debugging.

The live tool list distinguishes inherited built-in tools, enabled tools, explicitly
disabled tools, and tools unavailable because their plugin has not been granted.

### Deleting an account

Delete an account from its action menu. Deletion is destructive: Elowen tears down
managed sessions and processes, removes the account's settings, memories, brain data,
push subscriptions, project assignments, and plugin-owned account data.

Elowen will not delete an administrator. Demote the account first; the last remaining
administrator cannot be demoted. The last account in the installation cannot be
deleted.

## Project assignment

Project assignment is the main visibility boundary for members:

1. Open **Users** and select the member.
2. In **Projects**, select **Manage**.
3. Select the projects the member may access and save.

An unassigned member sees no project data. Project-scoped routes and views are filtered
to the member's assigned project set; one member cannot use assignment to inspect
another member's projects.

Administrators do not need individual project assignments. Assignments are removed when the account is deleted.

## Direct platform chats

A direct 1:1 platform chat is treated as personal only when the platform sender has a verified external identity
linked to an Elowen account. Groups and channels are shared conversations, even when a sender has an administrator
role in that platform room. Shared conversations resolve account-scoped state for the verified sender on that turn;
they do not inherit the account that originally opened the room.

A private chat first created before its sender was linked may initially be anchored to the instance operator. Once the
sender is verified, Elowen can adopt that direct chat for the sender without moving its transcript, usage, or files.

## Models, plugins, and tools

Access is layered. A user must pass every applicable layer before a tool or model can
run.

### Models

Use the user's **Allowed models** control to restrict which configured models that
account may use. An empty selection means no additional per-user restriction: the
account remains limited by the installation's globally allowed executors and by the
models actually configured for the daemon.

Adding selections narrows the account to those models. It never adds a model that the
installation cannot run.

### Plugins

Some plugins are marked as user-grantable. A user-grantable plugin is unavailable to a
member until an administrator grants it in the user's **Granted plugins** section.
Administrators are not restricted by those per-user plugin grants.

Granting a plugin makes its gated tools, API routes, UI, and contributed skills eligible for the account; it does not bypass project, filesystem, or tool-permission checks. Prompt fragments, platform prompts, slash commands, and hooks are not gated by the plugin grant.

### Individual tools

The user's **Tools** section controls the positive allow-list for individual toggleable plugin tools. For a
non-administrator, an empty allow-list grants no plugin tools; a wildcard or family entry such as `mcp__*` can
cover matching tools. The separate **disabled tools** list is an explicit deny-list and still applies to
administrators. Built-in inherited tools are shown for visibility but cannot be switched off there. A tool shown
as unavailable must be enabled through its plugin grant first.

Tool grants are not clamped to the currently loaded catalogue, so a grant can survive a disabled plugin or an
offline personal MCP server; it simply matches nothing until the tool exists again. Unknown tool names likewise
have no effect.

A terminal grant is not automatically unrestricted host access. Fresh configuration bubblewrap-confines non-operator commands to accessible Projects and account HOME, failing closed when confinement is required but unavailable. An operator can deliberately set `sandbox.confineNonOperators` to `false`; then granted non-operators run terminal commands directly on the host. File tools and workspace-scoped execution keep their own path/workspace boundaries.

## Permission rules

Permission rules decide what happens when a user's already-available tool is called.
Open **Account → Elowen AI → Permission rules** to edit the current account's rules.
Rules are saved immediately.

Each rule uses one of three actions:

- **allow** — run without approval;
- **ask** — request approval when a human approval surface is available;
- **deny** — refuse the call and return an error to the model.

There are two pattern spaces:

- `tools` matches a tool name, such as `Write`.
- `bash` matches the shell command string, so `git *` and `rm *` can have different
  decisions even though both use the `Bash` tool.

Rules are evaluated in order and the **last matching rule wins**. User rules are
appended after the built-in defaults, so a user rule can override a default. The
built-in behavior allows read-only tools, asks before `Write` and `Edit`, and asks for
shell commands except for the non-destructive inspection allow-list.

A shell line containing multiple simple commands is checked command by command. An
allow for one command does not automatically allow a later destructive command in the
same line.

### YOLO mode

The **YOLO** setting in **Account → Elowen AI** changes `ask` decisions to `allow`
without prompting. An explicit `deny` rule still denies. The setting is the default for
new sessions; `/yolo` in `elowen chat` changes it for the current session only.

YOLO is not a substitute for grants or deny rules: it cannot make an unavailable tool
available and it cannot override `deny`.

### Unattended asks

Chat platforms, scheduled runs, and delegated sub-agents do not have a human waiting
on an approval prompt. **Account → Elowen AI → Unattended asks** controls what happens
to an `ask` rule there:

- **allow** (default) — treat `ask` as allowed so autonomous work can continue;
- **deny** — refuse `ask` calls in unattended turns.

Strict unattended denial is independent of YOLO and is not overridden by it.

## Activity and audit limits

The **Activity** feed is an operational overview, not a complete audit log. It currently records turn activity,
SSO login/link/provision/denial events, and plugin events that explicitly publish them. Turn activity is aggregated
into short windows, and the feed is retained only for the configured event-retention period (30 days by default).

The team feed intentionally exposes only actor, surface, counts, and limited tool summaries; it does not provide
message text, commands, paths, or a full per-request record. Activity and usage data can also be incomplete for
legacy, unattributed, failed, or otherwise unrecorded work. Account memory changes have a separate, user-scoped
memory audit trail; they are not a replacement for an instance-wide administrative audit log.

## Delegated sub-agents

A delegated sub-agent receives a captured access scope from its parent, including the
admin status, project set, tool policy, permission boundary, and read-only state. It
does not receive a separate broad `agent` API token or the parent's personal memory
identity.

Delegation can only narrow access:

- `tools` can remove tools from the caller's own set, never add them.
- `read_only` removes write tools and applies a non-destructive shell boundary.
- Read-only mode is a guardrail, not a filesystem sandbox: shell redirection can still
  write wherever the surrounding path permissions allow.
- Continuing a child is refused if its stored scope is broader than the caller's
  current authority.
- `write_access: true` can promote only a read-only child explicitly requested by the
  same principal, and only when it fits within the caller's current access. It cannot
  override read-only mode imposed by the agent definition or plan mode.

## API operations

The web UI is the recommended administration surface. Administrators can also use the
generic authenticated CLI passthrough:

```bash
elowen api GET /users
elowen api GET /users/12/projects
elowen api POST /users/12/projects '{"projectId":3}'
```

Relevant administrator routes include:

- `GET /users` and `POST /users`
- `PATCH /users/:id` and `DELETE /users/:id`
- `GET /users/:id/tools` and `GET /users/:id/stats`
- `GET /users/:id/projects`, `POST /users/:id/projects`, and
  `DELETE /users/:id/projects/:pid`
- `POST /users/:id/impersonate`

The generic API command uses the same bearer token as `elowen chat`; it does not create
a second permission model.

## External identities and SSO

External identities are uniquely bound by provider, tenant, and subject. One external identity can belong to only
one Elowen account, and one account cannot hold two subjects for the same provider and tenant. The immutable
external subject is the authentication key; an email address is only a controlled linking aid.

Microsoft SSO is tenant-scoped. When configured, linking by matching a unique email address is enabled by default.
Ambiguous legacy email matches are refused, and an existing subject binding wins over a conflicting email match.
Automatic account provisioning remains disabled unless `ssoProvision` is explicitly set to the configured tenant.
Provisioned accounts are passwordless local accounts with a random discarded password and start as non-admins with
no positive plugin-tool grant.

Provisioning also requires the Microsoft Graph directory check to identify an enabled member; guests, disabled or
non-member accounts, and unavailable directory checks are refused. External provisioning cannot create the first
administrator, and it does not silently replace an existing link. Create the first administrator through first-run
setup, then use explicit administrative linking or tenant provisioning.

[Next: Troubleshooting](troubleshooting)
