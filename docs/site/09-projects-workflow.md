---
title: Projects & Workflow
slug: projects-workflow
order: 9
eyebrow: Guide
---

# Projects & Workflow

Orca is an agent you talk to that acts on your code. **Projects** are how you
point that agent at your git repositories and scope exactly what it may touch.
Each project maps to a repository on disk and carries its own task queue,
missions, and access controls — so the agent always works inside boundaries you
set, and you always see what it changed.

This page covers how the agent works against your repos: projects and git
integration, the PR-native worktree workflow, the Monaco editor, change
snapshots, and the handoff notes agents leave for each other.

## Projects

A project is a named handle on one git repository. You create projects in the
**Projects** page, and from there the agent can plan [tasks and
missions](tasks-missions) against them, open the editor, and run tools scoped to
that repo.

![The Projects list](images/projects-list.png)

| Setting | Description |
|---------|-------------|
| **Slug** | Unique identifier, immutable after creation — it appears in API routes (`/projects/:slug`) |
| **Path** | Absolute path to the git repository on disk |
| **Notes** | Free-form context handed to the planner and Pilot agents when they work this repo |
| **PR workflow** | Enable, disable, or inherit the PR-native workflow for this project |

The **Notes** field is a simple, high-leverage way to steer the agent: describe
the stack, conventions, or "don't touch" areas once, and every task planned
against this project inherits that context.

Access is per user. Under [RBAC](account-security), an admin assigns which users
can see and act on each project (`user_projects`), so one person's agent might
reach three repos while another's is scoped to one. Combined with per-user tool
grants, you decide not just *which* projects a user reaches but *what* their
agent may do there.

## Git integration

Every project surfaces the live state of its repository, so you can steer the
agent with full visibility instead of guessing:

- Current branch
- Clean or dirty working tree
- Ahead/behind counts versus the remote
- Recent commits (hash, subject, author, time)
- Branch list, with the current branch highlighted

This is the clarity pillar in practice — before you engage the agent on a repo,
you can see exactly where it stands.

## PR-native workflow

For anything you want reviewed before it lands, turn on the **PR-native**
workflow. Instead of editing your shared checkout in place, each mission gets its
own isolated git worktree, commits per phase, and opens a real pull request you
can review.

Toggle it per project (the **PR workflow** setting) or per mission
(inherit / on / off). Configure your GitHub token and PR defaults in
**Settings → GitHub** (see [Configuration](configuration)).

### How it works

1. **Engage with PR mode** — the mission runs in PR mode (inherited from the
   project or set explicitly).
2. **Worktree** — Orca creates an isolated git worktree at
   `<repo-parent>/.orca-worktrees/<slug>-<missionId>`, separate from your main
   checkout.
3. **Isolated work** — the agent does all its work inside that worktree, never
   touching your working branch.
4. **Per-phase commits** — each closed phase commits its changes to the
   worktree branch.
5. **PR auto-opens** — after the first phase closes, Orca opens a pull request
   against the base branch.
6. **Review feedback ingested** — review comments (inline + summary) are pulled
   back in and handed to the agent.
7. **Auto-fix rounds** — review feedback triggers fix phases on the same branch.
   A budget of **2** automatic rounds prevents review ping-pong; once it's spent,
   the mission stalls and escalates to a human via [Escalations](web-ui).
8. **Merge and clean up** — when it's done, the PR merges and the worktree is
   removed.

Because every PR mission lives in its own worktree, **PR missions never block
each other or the shared checkout** — they run concurrently and safely. The
shared checkout (non-PR work) allows only **one agent at a time**, checked
atomically before a task flips to `in_progress`, so two agents can never trample
the same working tree.

## Monaco editor

![The project editor](images/projects-editor.png)

Orca ships a self-hosted Monaco editor built directly into the web UI — no
external service, in keeping with the lightweight, self-hosted design. Open it
from the **Open editor** button on any project card. It's how you inspect and
adjust what the agent produced, or make quick edits yourself.

| Component | Purpose |
|-----------|---------|
| **File tree** | Browse project files, with dirty-state highlights |
| **Tabs** | Multi-file editing with dirty indicators |
| **Editor pane** | Monaco with an OLED-friendly theme |
| **Diff mode** | Working changes versus `HEAD` |
| **Patch view** | Unified diff for a specific commit |
| **Preview** | Inline image and Markdown preview |
| **Context menu** | Right-click for new file/folder, rename, duplicate, delete |

The editor is one of several ways to observe and steer the agent — see the
full tour on the [Web UI](web-ui) page.

## Change snapshots

Every task keeps a permanent record of what the agent changed, so nothing the
agent does is opaque:

1. **At spawn** — the current `HEAD` is stamped on the task as `base:<sha>`.
2. **At close** — Orca computes and stores `git diff base..HEAD --name-only`,
   freezing the exact list of files that phase touched.
3. **Viewing** — fetch a single file's diff with
   `GET /tasks/:id/changed/diff?path=<file>`.

The result is a per-phase change record visible in the task detail and the
[Timeline](web-ui), so you can always answer "what did this phase actually do?"

Git operations on a single checkout are serialized through a `KeyedMutex` — only
one agent reads `HEAD` or commits at a time — while different checkouts
(worktrees) run concurrently. That's what lets many PR missions proceed in
parallel without corrupting any one repository.

## Handoff notes

Missions run in phases, and a later phase often needs context only an earlier
agent had. Agents leave each other **handoff notes** for exactly this:

```bash
# Leave a note for later phases of a mission
orca note add <missionId> "Set up the KeyedMutex in src/shared/keyedMutex.ts"

# Read all notes left by earlier phases
orca note ls <missionId>
```

The worker prompt instructs every agent to read the notes at the start of its
phase and leave notes at close, so knowledge carries forward across a mission
instead of being lost between phases. See the full command reference on the
[CLI](cli) page.

[Next: Configuration](configuration)
