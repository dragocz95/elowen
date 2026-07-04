---
title: Account & Security
slug: account-security
order: 11
eyebrow: Guide
---

# Account & Security

## Authentication

Orca uses **Bearer token** authentication for all API requests except
`GET /health` and `POST /auth/login`.

```http
Authorization: Bearer <token>
```

### Web UI auth (BFF proxy)

The web UI never sees the token. It uses a same-origin `/api` BFF proxy with
an httpOnly session cookie. The browser sends requests with
`credentials: 'same-origin'` and the Next.js proxy injects the daemon bearer
from the cookie.

### Token scopes

| Scope | Purpose |
|-------|---------|
| `full` | Interactive user sessions (web UI, CLI) — full access |
| `agent` | Spawned agents — restricted allow-list (close tasks, submit plans) |
| `advisor` | Per-user assistant — mapped to `full` rights, isolated from login tokens |

Agent-scoped tokens are confined to the project they're working on. A worker
agent can only close its own tasks.

### Login

```http
POST /auth/login
Content-Type: application/json

{ "username": "admin", "password": "test99" }
```

Returns a bearer token. Rate-limited to 10 attempts per 5 minutes per IP
(prefers `x-real-ip` header).

### Password policy

- Minimum 8 characters
- Changed via `POST /auth/me/password` (requires current password)

## Multi-tenancy & RBAC

### Roles

| Role | Access |
|------|--------|
| **Admin** | Everything — all projects, all users, all settings |
| **Member** | Only assigned projects — tasks, sessions, activity, editor |

### Project assignment

Members must be explicitly assigned to projects (admin-only, in **Users**
page). An unassigned member sees a blank dashboard.

### Model allow-list

Admins can restrict which executors a non-admin may use:

- **Global** — `config.allowedExecs` (applies to everyone)
- **Per-user** — user's `allowed_execs` (narrower than global)

A user with an empty allow-list is unrestricted (subject to the global list).

## Push notifications

Orca supports PWA push notifications via the VAPID protocol:

1. **Subscribe** — Account → Notifications → Enable on this device
2. **Events** — mission escalations, needs_input signals, stalls, completions
3. **Actions** — inline buttons (Allow/Reject, Approve/Rerun, Open) in the
   notification
4. **Service worker** — `public/sw.js` handles push events and notification
   clicks

### Inline action buttons

| Action | Effect |
|--------|--------|
| **Allow** | Sends Enter keystroke to the waiting agent |
| **Reject** | Sends Escape keystroke |
| **Approve** | Releases the review gate on a blocked phase |
| **Rerun** | Re-opens the task and resumes the mission |

## Web push security

- VAPID keys auto-generated on first boot, persisted in the config store
- Private key never leaves the daemon
- Dead subscriptions (404/410) are pruned automatically
- Subscription endpoints are per-user and scoped to the authenticated session

[Next: Architecture](architecture)
