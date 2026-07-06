---
title: Account & Security
slug: account-security
order: 11
eyebrow: Guide
---

# Account & Security

Orca is a personal AI agent you talk to — it reasons, edits files, runs commands
and works across chat platforms on your behalf. An agent with that much reach has
to be locked down properly, so security is not an afterthought here: every request
is authenticated, every user gets exactly the tools and models you grant them, and
every action is scoped to a project. This page covers how that works and how you
control it.

Clarity and simplicity apply to security too. You always know who can do what — the
[Users](web-ui) page shows each person's effective tools at a glance — and the
defaults are safe, so you can hand access to a teammate without wiring anything up
by hand.

## Authentication

Orca uses **Bearer token** authentication on every API request except
`GET /health` and `POST /auth/login`.

```http
Authorization: Bearer <token>
```

The daemon exposes its REST API on `:4400`. Send the token on every call and the
daemon resolves it to a user and a scope before anything runs.

## Web UI auth (BFF proxy)

The web UI on `:4500` never sees the daemon token. It talks to a same-origin `/api`
BFF (backend-for-frontend) proxy backed by an **httpOnly session cookie**. Your
browser sends requests with `credentials: 'same-origin'`, and the Next.js proxy
injects the daemon bearer from the cookie server-side.

The upshot: the powerful daemon token never reaches client JavaScript, so it can't
be read by an XSS payload or a browser extension. The cookie is httpOnly, so scripts
can't read it either.

## Token scopes

Not every token is equal. Orca issues three scopes so an agent it spawns can never
act with your full rights.

| Scope | Purpose |
|-------|---------|
| `full` | Interactive user sessions (web UI, CLI) — full access |
| `agent` | Spawned agents — restricted allow-list (e.g. close their own task, submit plans), confined to their project |
| `advisor` | Per-user assistant — granted full rights but isolated from your login tokens |

Agent-scoped tokens are confined to the project they're working on: a worker agent
can only close its own tasks and can't reach across to another project. The `advisor`
scope grants the same rights as `full` but is stored separately, so stopping or
rotating a user's advisor never touches their login session.

## Login & password policy

```http
POST /auth/login
Content-Type: application/json

{ "username": "admin", "password": "your-password" }
```

A successful login returns a bearer token. Login is **rate-limited to 10 attempts
per 5 minutes per IP** (Orca prefers the `x-real-ip` header over `x-forwarded-for`),
which blunts brute-force attempts.

Password policy:

- Minimum **8 characters**.
- Changed via `POST /auth/me/password`, which requires the **current password** —
  so a hijacked session can't silently rotate the password without knowing it.

You can set an initial admin at first boot with the `ORCA_BOOTSTRAP_USER` and
`ORCA_BOOTSTRAP_PASS` environment variables (see [Configuration](configuration)).

## RBAC: roles

Orca ships **full role-based access control**. There are two roles:

| Role | Access |
|------|--------|
| **Admin** | Everything — all projects, all users, all settings |
| **Member** | Only assigned projects — tasks, sessions, activity, editor |

Roles are the coarse layer. The powerful part is what sits underneath them:
**each user can have a completely different set of tools and permissions.**

![RBAC — the Users page with per-user tools, models and project assignment](images/users-rbac.png)

## Per-user tools & models

This is the headline of Orca's security model, so it's worth spelling out. Beyond
the admin/member role, an admin controls three things **per user** on the
[Users](web-ui) page:

- **Per-user tools (`disabled_tools`)** — turn individual brain tools off for a
  specific person. Every capability in Orca is a tool ([Plugins](plugins) register
  them), so you can grant one user `terminal` + `files` and give another only chat.
  Disable `terminal` for a junior member and they simply won't have shell access,
  no matter what they ask the agent to do.
- **Per-user models (`allowed_execs`)** — restrict which executors that user may
  run. This is a per-user allow-list, narrower than the global `allowedExecs` in
  [Settings](configuration). An empty per-user list means "unrestricted within the
  global list" — so you widen access by adding entries, not by leaving it blank.
- **Effective access at a glance** — the Users detail pane renders each user's
  live tool access as **ToolPills**, so you see the real, computed result of role +
  disabled tools without having to reason it out.

In practice: give one teammate a full engineering toolkit, give another a chat-only
account, and scope a contractor to a single project — all from one pane, all
auto-saved. That per-user tools-and-rights model is a core pillar of Orca, not a
bolt-on.

## Project assignment & visibility

Members don't see anything until you say so. Assignment is admin-only, done on the
[Users](web-ui) page.

- A member must be **explicitly assigned** to a project to work in it. An unassigned
  member sees a blank dashboard — safe by default.
- Assignment also **scopes visibility**: a member sees only the projects, tasks,
  sessions and activity for the projects they're on. This keeps the UI uncluttered
  and keeps work isolated between people who shouldn't see each other's repos.

Assignments live in a `user_projects` mapping and are removed cleanly when a user
is deleted, so you never leave orphan grants behind.

## Push notifications

Because the agent runs autonomously, you want to know the moment it needs you. Orca
supports **PWA push notifications** over the VAPID protocol.

![Account settings — notifications and per-device subscriptions](images/account-settings.png)

1. **Subscribe** — Account → Notifications → enable on this device. Subscription is
   per device, so each phone or laptop opts in on its own.
2. **Events** — mission escalations, `needs_input` signals, stalls, and completions.
3. **Actions** — inline buttons let you respond straight from the notification.
4. **Service worker** — `public/sw.js` handles incoming push events and clicks.

### Inline action buttons

| Action | Effect |
|--------|--------|
| **Allow** | Sends an Enter keystroke to the waiting agent |
| **Reject** | Sends an Escape keystroke |
| **Approve** | Releases the review gate on a blocked phase |
| **Rerun** | Re-opens the task and resumes the mission |

This is the human-in-the-loop gate at your fingertips — approve an
[escalation](web-ui) or steer an agent without opening the app. See
[Agents & Autonomy](agents-autonomy) for how autonomy levels L0–L3 decide when the
agent stops to ask.

## Web push security

The push channel is scoped and self-maintaining:

- **VAPID keys** are auto-generated on first boot and persisted in the config store.
  You don't manage them.
- The **private key never leaves the daemon** — the browser only ever holds the
  public key.
- **Dead subscriptions** (endpoints returning 404/410) are pruned automatically, so
  the store doesn't rot.
- Subscription endpoints are **per-user and scoped to the authenticated session** —
  a user only ever receives notifications for their own work.

[Next: Architecture](architecture)
