---
title: Projects & Workflow
slug: projects-workflow
order: 9
eyebrow: Guide
---

# Projects & Workflow

Projects are the unit of organization in Orca. Each project maps to a git
repository on disk and carries its own task queue, missions, and access
controls.

## Projects

| Setting | Description |
|---------|-------------|
| **Slug** | Unique identifier (immutable after creation) |
| **Path** | Absolute path to the git repository on disk |
| **Notes** | Free-form context for the planner and Pilot agents |
| **PR workflow** | Enable/disable/inherit PR-native workflow |

Create projects in **Projects** page. The slug is used in API routes
(`/projects/:slug`).

### Git integration

Each project displays:

- Current branch
- Clean/dirty status
- Ahead/behind counts vs remote
- Recent commits (hash, subject, author, time)
- Branches list with current highlighted

## PR-native workflow

Orca supports a **PR-native** workflow where missions create isolated git
worktrees and open pull requests automatically.

### How it works

1. **Engage with PR mode** — toggle PR workflow on the mission (inherit/on/off)
2. **Worktree** — a separate git worktree is created at
   `<repo-parent>/.orca-worktrees/<slug>-<missionId>`
3. **Agent** — the agent works in the worktree, isolated from the main branch
4. **Phase commits** — each closed phase commits its changes to the worktree
5. **PR auto-open** — after the first phase closes, a PR is opened against the
   base branch
6. **Review feedback** — PR review comments (inline + summary) are ingested
7. **Auto-fix rounds** — review feedback triggers fix phases on the same branch.
   A budget of 2 automatic rounds prevents review ping-pong loops; after that,
   the mission stalls and escalates to a human
8. **Merge** — when done, merge the PR and clean up the worktree

PR missions never block each other or the shared checkout — each runs in its
own worktree. The shared checkout allows only one agent at a time
(checked atomically before flipping `in_progress`).

PR missions don't block each other or the shared checkout — each runs in its
own worktree.

Configure GitHub token and PR defaults in **Settings → GitHub**.

## Monaco editor

![Screenshot of the project editor](images/projects-editor.png)

A self-hosted Monaco code editor integrated directly into the web UI:

| Component | Purpose |
|-----------|---------|
| **File tree** | Browse project files with dirty-state highlights |
| **Tabs** | Multi-file editing with dirty indicators |
| **Editor pane** | Monaco editor with OLED-friendly theme |
| **Diff pane** | Working changes vs HEAD diff |
| **Patch view** | Unified diff for git commits |
| **Context menu** | Right-click: new file/folder, rename, duplicate, delete |

Open via the **Open editor** button on any project card.

## Change snapshots

When a task closes, Orca freezes the list of files the agent changed:

1. **At spawn** — the current `HEAD` is stamped as `base:<sha>` on the task
2. **At close** — `git diff base..HEAD --name-only` is computed and stored
3. **Viewing** — `GET /tasks/:id/changed/diff?path=<file>` returns the file diff

This gives you a permanent record of what each phase changed, viewable in the
task detail and timeline.

### KeyedMutex serialization

Git operations on one checkout are serialized through a `KeyedMutex` — only
one agent can read HEAD or commit at a time. Different checkouts (worktrees)
run concurrently.

## Handoff notes

Agents working on the same mission can leave notes for later phases:

```bash
# Leave a note for the next phase
orca note add <missionId> "I set up the KeyedMutex in src/shared/keyedMutex.ts"

# Read all notes left by earlier phases
orca note ls <missionId>
```

The worker prompt tells agents to read notes at start and leave them at close.

[Next: Configuration](configuration)
