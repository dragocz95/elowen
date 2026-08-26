---
title: Skills
slug: skills
order: 24
eyebrow: Extending
group: Extending
---

# Skills

A skill is a reusable Markdown procedure that Elowen can apply in later conversations. Use one for repeatable know-how: a deployment checklist, a report format, or project-specific conventions. Use [Memory](memory) for durable facts, and the conversation task list for steps in the request you are handling now.

Skills are progressive-disclosure instructions. Elowen normally sees only each skill's name and description. When a task matches, it loads the complete skill body and follows it.

## Before you start

The **Skills** plugin must be enabled. For a non-admin account, an administrator must also grant the account access to the plugin:

1. Open **Users**.
2. Select the account.
3. Open **Granted plugins → Manage**.
4. Select **Skills** and save.

If the plugin is unavailable, `CreateSkill`, `ListSkills`, `SkillLoad`, and `DeleteSkill` are not available to that account. See [Plugins](plugins) for plugin access and reload behavior.

## Use a skill

### Automatic use

Write a precise description of when the skill applies. On a matching task, Elowen can load it by its exact name and use its Markdown instructions. Keep the description short and make it a trigger, for example:

```text
Use when preparing the weekly customer-support report.
```

The complete body is not placed in every prompt, which keeps unrelated conversations smaller.

### Explicit use

Load a skill into the current conversation with:

```text
/skill:<name>
```

Replace `<name>` with the exact skill name, such as `/skill:deploy-checklist`. This works in the Web UI and CLI. The command expands the skill's complete instructions into the conversation; it does not change the skill file.

To browse loaded skills, use `/skills` in chat. In the CLI and Web UI, this opens the skills picker, where you can filter skills and load one into the current conversation. A skill marked **manual only** cannot be selected automatically, but remains available through `/skill:<name>`.

The agent tools provide the same operations:

- `ListSkills` lists the skills visible to the current account, their scope, descriptions, and whether they are manual only.
- `SkillLoad` loads the complete body of one available skill by exact name.
- `DeleteSkill` permanently removes a custom skill you are allowed to manage.

## Create a skill

The `CreateSkill` tool saves a skill for future conversations. It requires an explicit scope:

```text
CreateSkill({
  name: "deploy-checklist",
  description: "Use before deploying a new service version.",
  content: "# Deployment checklist\n\n1. Run the focused tests.\n2. Verify the health endpoint.",
  scope: "personal"
})
```

Fields:

- **`name`** — lowercase letters, digits, and dashes; it is also the skill's identifier and file name.
- **`description`** — one line describing when to use the skill. This is the trigger Elowen reads before loading the body.
- **`content`** — the Markdown procedure, rules, examples, and supporting instructions.
- **`scope`** — `personal` or `instance`:
  - `personal` makes the skill available to turns attributed to your account. It is not shared with other accounts.
  - `instance` makes the skill available across the instance. Writing this scope is restricted to the instance owner, not merely an administrator.

Creating a personal skill with an existing name updates that skill. A skill cannot shadow a bundled skill or another skill in a conflicting scope; choose a different name when Elowen reports a name collision.

Successful changes are applied after the current turn settles and are available from the next message. A daemon restart is not required.

## Manage skills in the Web UI

Open the Skills workspace at `/p/skills/`, or open **Settings → Plugins → Skills**. The manager lets you:

- add and edit custom skills;
- choose whether a skill is visible to **Only me** or **Everyone** when you have the required authority;
- turn **Use automatically** on or off;
- delete custom skills after confirmation;
- view bundled, instance-wide, and personal skills separately.

Bundled skills are read-only. Administrators can manage instance-wide skills and, where appropriate, other accounts' custom skills; ordinary accounts can manage their own personal skills.

Turning **Use automatically** off adds the `disable-model-invocation: true` flag. The skill remains available for explicit `/skill:<name>` use, but its name and description are omitted from automatic skill discovery.

## Skill file format

Skills can be stored either as a flat Markdown file or as a directory containing `SKILL.md`:

```text
# Flat skill
<name>.md

# Directory skill with supporting files
<name>/
  SKILL.md
  references/
  scripts/
```

A skill file uses YAML frontmatter followed by a Markdown body:

```markdown
---
name: deploy-checklist
description: Use before deploying a new service version.
---

# Deployment checklist

1. Run the focused tests.
2. Verify the health endpoint.
```

The `description` is required for a file to be loaded. You may add:

```yaml
disable-model-invocation: true
```

to make the skill manual only. Relative paths in a skill's instructions resolve from the skill directory: the directory containing the flat file, or the directory containing `SKILL.md` for the directory form.

## Where files live

For the default Elowen data directory:

- **Instance-wide custom skills:** `~/.config/elowen/plugins-data/skills/`
- **Personal skills:** `~/.config/elowen/plugins-data/skills/users/<account-id>/`
- **Bundled skills:** shipped with the Skills plugin and read-only

If the daemon uses a custom database location, its `plugins-data/` directory is beside that database. Prefer the Web UI or the skill tools so ownership and reload rules are enforced correctly.

## Good skill boundaries

Create a skill when a procedure is:

- repeated across conversations;
- important enough to follow consistently;
- specific to a project, team, or operating environment.

Do not put secrets in a skill. Do not use a skill as a substitute for access control: a skill can describe a safe procedure, but the account's existing project, tool, and plugin permissions still apply.

## Troubleshooting

- **No Skills tools or picker:** enable the Skills plugin and check the account's plugin grant.
- **The model never selects a skill:** improve its one-line description, or check that **Use automatically** is enabled.
- **`/skill:<name>` does not work:** use `ListSkills` or `/skills` to confirm the exact name and that the skill is available to the current account.
- **A file is ignored:** verify the YAML frontmatter, a non-empty `description`, and the flat or directory layout above.
- **A new or edited skill is not visible yet:** send the next message after the plugin reload completes; current turns are not rewritten retroactively.

[Next: MCP Integration](mcp)
