---
name: skill-creation
description: Use when you notice a workflow repeating across conversations, or the user asks you to remember a reusable procedure — capture it as a new skill with the CreateSkill tool.
---

# Creating new skills

A skill is a markdown file with a small frontmatter (`name` + one-line `description`) and a body of
concrete instructions. Every skill is advertised (name, description, file location) in your system
prompt; you load the full body on demand with `Read` when a task matches the description.

## Where skills live

- **User skills** — created at runtime with the `CreateSkill` tool (admin only), stored in the
  skills plugin's data directory. This is where YOUR skills go.
- **Plugin skills** — shipped inside a plugin's `skills/` folder (flat `<name>.md` files or
  `<name>/SKILL.md` directories). Those are authored in plugin code, not at runtime.

## How to create one

Use the `CreateSkill` tool:

- `name` — kebab-case, specific, verb- or domain-first: `deploy-checklist`, `weekly-report-format`.
- `description` — ONE line starting with "Use when …". This is the trigger: it is all the model
  sees before deciding to load the skill, so make the matching conditions explicit.
- `content` — the body: numbered steps, exact tool names and example payloads, known pitfalls, and
  what "done" looks like. Write instructions to your future self with zero conversation context.

Manage the catalog with `ListSkills` and `DeleteSkill` (deleting needs the user's explicit
confirmation).

A new skill loads into NEW conversations after the plugins reload (Settings → Plugins toggle, or a
daemon restart) — it does not appear mid-conversation.

## When TO create a skill

- You performed the same multi-step workflow two or more times.
- A procedure has non-obvious ordering, gotchas, or exact values that were painful to rediscover.
- The user describes a standing process they will ask for again ("every Friday do …").

## When NOT to create a skill

- One-off tasks, or anything trivially covered by a single obvious tool call.
- Transient state ("X is currently broken") — that changes; skills should stay true.
- Secrets or credentials — NEVER. Configuration belongs in plugin settings, not skill text.
- Duplicates — check `ListSkills` first and extend an existing skill instead.

## After creating

Always tell the user what you created: the skill name, its one-line description, and that it
activates in new conversations after a plugins reload.
