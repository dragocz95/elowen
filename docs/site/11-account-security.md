---
title: Account & Security
slug: account-security
order: 11
eyebrow: Guide
---

# Account & Security

Elowen is a personal AI agent you talk to — it reasons, edits files, runs commands
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

Elowen uses **Bearer token** authentication on every API request except
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

Not every token is equal. Elowen issues three scopes so an agent it spawns can never
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

## Session token lifetime

Login tokens are not eternal. Every token carries a **time-to-live**, and the daemon
rejects it once it expires — forcing a fresh login rather than leaving a stale
credential valid forever.

- The TTL defaults to **30 days** and is set globally under
  [Settings](configuration) → Security (`security.tokenTtlDays`, minimum 1 day).
- On login the daemon returns the TTL alongside the token, so the web BFF pins its
  httpOnly session cookie to exactly that window — the cookie and the token expire
  together, no drift.

## Login & password policy

```http
POST /auth/login
Content-Type: application/json

{ "username": "admin", "password": "your-password" }
```

A successful login returns a bearer token. Login is **rate-limited to 10 attempts
per 5 minutes per IP** (Elowen prefers the `x-real-ip` header over `x-forwarded-for`),
which blunts brute-force attempts.

Password policy:

- Minimum **8 characters**.
- Changed via `POST /auth/me/password`, which requires the **current password** —
  so a hijacked session can't silently rotate the password without knowing it.

You can set an initial admin at first boot with the `ELOWEN_BOOTSTRAP_USER` and
`ELOWEN_BOOTSTRAP_PASS` environment variables (see [Configuration](configuration)).

## RBAC: roles

Elowen ships **full role-based access control**. There are two roles:

| Role | Access |
|------|--------|
| **Admin** | Everything — all projects, all users, all settings |
| **Member** | Only assigned projects — tasks, sessions, activity, editor |

Roles are the coarse layer. The powerful part is what sits underneath them:
**each user can have a completely different set of tools and permissions.**

![RBAC — the Users page with per-user tools, models and project assignment](images/users-rbac.png)

## Per-user tools & models

This is the headline of Elowen's security model, so it's worth spelling out. Beyond
the admin/member role, an admin controls three things **per user** on the
[Users](web-ui) page:

- **Per-user tools (`disabled_tools`)** — turn individual brain tools off for a
  specific person. Every capability in Elowen is a tool ([Plugins](plugins) register
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
auto-saved. That per-user tools-and-rights model is a core pillar of Elowen, not a
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

## Granular tool permissions

Disabling a tool outright is the blunt instrument. The sharp one lives in
**Account → Elowen AI → Permission rules**: for the tools a user *does* have, you
decide per pattern whether a call **runs, asks, or is refused**. Every tool call the
brain makes resolves to one of three actions:

| Action | Effect |
|--------|--------|
| **allow** | Runs immediately, no prompt |
| **ask** | Pauses for a human approval prompt where one is attached (owner chat); otherwise follows your unattended-asks setting |
| **deny** | Returns an error to the model — the call never runs |

Rules live in two independent pattern spaces. **`tools`** rules match a tool by
**name** (e.g. `write_file`). **`bash`** rules match the **command string** of the
shell tool — so `git *` can be allowed while `rm *` is denied, even though both run
through the same `run_command` tool.

The built-in defaults are conservative but frictionless: read-only tools are allowed,
file edits (`write_file`, `edit_file`) **ask**, and shell commands **ask** except for
a small read-only allow-list (`git status`, `git diff`, `git log`, `ls`, `cat`,
`grep`, `pwd`, `which`). Your own rules append **after** those defaults, and
resolution is **last-match-wins** — so any rule you add always overrides a built-in,
and a later rule beats an earlier one. Put a catch-all like `*` first, then narrow.

- **Self-service editor** — the Permission rules card lists your bash rules with an
  add row (pattern + allow/ask/deny), and tool-name rules below when you have any.
  Adding, retoning or deleting a rule persists immediately.
- **"Always allow" writes a rule** — when an approval prompt offers *Always allow*,
  picking it appends the matching pattern (e.g. `git status --porcelain` →
  `git status*`) to this very list, so grants you make in chat show up here.
- **Chaining can't be smuggled** — a shell line is split into its simple commands and
  each is gated on its own, taking the most restrictive decision. An allow that
  matched only the first program can't wave through `cat x && rm -rf ~`.

### YOLO mode

**YOLO** flips every `ask` to `allow` without prompting (a `deny` rule still denies).
Set your **persisted default** with the YOLO toggle in Account → Elowen AI — it applies
to new sessions. Inside a running `elowen chat` session the **`/yolo`** command
overrides it just for that session, without touching your saved default. There's a
standing warning on the toggle for a reason: auto-approving tool runs is a real
security trade-off.

### Unattended-asks (strict mode)

An `ask` only pauses when a human is actually parked on the approval prompt — the
owner's CLI or web chat. On an **unattended** turn (a chat platform, a cron run, a
spawned subagent) there's nobody to ask, so what happens is your call:

- **allow** (default) — an `ask` resolves to allow, keeping autonomous work moving.
- **deny** (strict mode) — an `ask` is refused outright. This is a hard safety
  opt-in: **YOLO never overrides a strict denial.**

## Personality & advisor style

Elowen isn't just capable — it can sound the way you want it to. Each user shapes their
own assistant voice, and none of it leaks between accounts.

**Communication style** is the always-on layer, set in **Account → Personality** as a
single pick: **Professional** (default), **Friendly**, **Concise** or **Detailed**.
It rewrites the assistant's register everywhere your brain runs — web chat and
`elowen chat` alike — and applies on top of any active persona profile.

**Persona profiles** go further. You can author named profiles per surface — **Web**
and **Discord** — each with a tone, a style, and a full instruction prompt written in
a Markdown editor. Enable one as the **active** profile for that surface and it's
pinned into the system prompt at spawn. Duplicate, edit, disable or delete them from
the same pane; runtime knobs (models, thinking level) stay in the Elowen AI section, so
personality and mechanics never tangle.

Discord is the exception worth calling out: it's a **shared, owner-anchored channel**,
not a per-user session. The bot wears **one persona** there — the channel **owner's**
active `discord` profile — so everyone talking to Elowen on Discord meets the same,
deliberately-configured face.

## Memory

The embedded brain can remember across conversations, and **Account → Memory** puts
both halves of that under your control as per-user toggles (both on by default):

- **Auto-recall** — before each reply, your most relevant durable memories are
  injected under your message, so the assistant already knows your standing context.
- **Auto-save** — after a turn, a curator persists genuinely new, reusable facts to
  *your* account.

They're read fresh each turn, so flipping one applies to your very next message, and
they cover web chat, `elowen chat` and your own verified Discord messages. See the
[Brain & Chat](brain-chat) guide for how recall and the curator work under the hood.

![Memory — the assistant's durable, per-user memory store](images/brain-memory.png)

## Your profile & identity links

**Account → Profile** is the personal side of the page: your display name, email and
avatar, plus a live **UI scale** slider that zooms the whole app (a per-device
preference, like the terminal look below).

Two fields here are more than cosmetic — they **link an external identity to your Elowen
account**, which is what lets the owner persona and per-user memory work off-web:

- **Discord user ID** — maps your Discord user to this account, so your Discord
  messages resolve to you (and, for the channel owner, drive the Discord persona).
- **WhatsApp number** — the same mapping for WhatsApp.

Both live in your personal settings and autosave as you type.

## Terminal appearance

Every web terminal — the advisor dock, session cards, the pop-out — honours a
per-user look set in **Account → Terminal**, with a live preview and autosave:

- **Font** — size and family (System, Menlo, IBM Plex, Courier).
- **Cursor** — block / bar / underline, with optional blink.
- **Theme** — `auto` follows the app theme, or `custom` unlocks a full 21-colour
  palette (with ready-made presets).
- **Scrollback** — how much history each terminal keeps.
- **Show thinking in CLI** — whether the agent's reasoning is streamed in the terminal.

## Push notifications

Because the agent runs autonomously, you want to know the moment it needs you. Elowen
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
