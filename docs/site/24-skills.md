---
title: Skills
slug: skills
order: 24
eyebrow: Extending
group: Extending
---

# Skills

A skill is a reusable Markdown procedure that Elowen can apply in later conversations. Use one for repeatable know-how: a deployment checklist, a report format, or project-specific conventions. Use [Memory](memory) for durable facts, and the conversation task list for steps in the request you are handling now.

Skills use progressive disclosure. Elowen normally sees only each available skill's name and description. When a task matches, it can load the complete body.

## Before you start

The **Skills** plugin must be enabled. `SkillLoad` is its canonical loader: it also controls which skills are advertised and expanded, including skills contributed by other enabled plugins.

For a non-admin account, an administrator must grant access to the Skills plugin:

1. Open **Users**.
2. Select the account.
3. Open **Granted plugins → Manage**.
4. Select **Skills** and save.

A skill contributed by a grantable sibling plugin also requires that plugin's grant. For example, an account needs both the **Skills** grant and the contributing plugin's grant to use that plugin's skill. Administrators bypass per-plugin grants. Account tool policy can still deny `SkillLoad`.

If the Skills plugin or its `SkillLoad` tool is unavailable, skill discovery and loading are unavailable to that turn. See [Plugins](plugins) for plugin access and live reload behavior.

## Use a skill

### Automatic use

Write a precise description of when the skill applies. On a matching task, Elowen can load it by its exact name and use its Markdown instructions. Keep the description short and make it a trigger, for example:

```text
Use when preparing the weekly customer-support report.
```

Only skills currently visible to the turn are advertised. Manual-only skills are omitted from automatic discovery, but remain available through explicit invocation.

The catalog is live rather than a permanent session snapshot. Changes to grants, plugin availability, ownership, or tool policy take effect on a subsequent turn after the plugin reload has completed.

### Explicit use

Load a skill into the current conversation with:

```text
/skill:<name>
```

Replace `<name>` with the exact skill name, such as `/skill:deploy-checklist`. This works in the Web UI and CLI. The daemon resolves the command against the live catalog on every invocation, then reads the current skill body; it does not rely on a stale session catalog. If the skill is unknown, revoked, denied, missing, unreadable, or outside its registered path boundary, the invocation fails closed and the agent is told that the skill is unavailable.

To browse loaded skills, use `/skills` in chat. In the CLI and Web UI, this opens the skills picker, where you can filter skills and load one into the current conversation. A skill marked **manual only** cannot be selected automatically, but remains available through `/skill:<name>`.

The agent tools provide the same operations:

- `ListSkills` lists the skills visible to the current account, their scope, descriptions, and whether they are manual only.
- `SkillLoad` loads the complete body of one skill by exact name from the live catalog.
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
  - `personal` makes the skill available only to the owning account's own, direct, and delegated sessions. It is not shared with other accounts.
  - `instance` makes the skill available across the instance, subject to the contributing plugin's grant policy. Writing this scope requires instance-operator authority; all administrators have that authority.

For a user, a personal definition takes precedence over an instance-wide definition with the same name. Shared or accountless work sees only eligible instance-wide skills; personal skills are not exposed there.

Creating a personal skill with an existing name updates that skill. A skill cannot shadow a bundled skill or another skill in a conflicting scope; choose a different name when Elowen reports a name collision.

Successful changes are applied after the current turn settles and are available from the next message. A daemon restart is not required.

## Manage skills in the Web UI

Open the Skills workspace at `/p/skills/`, or open **Settings → Plugins → Skills**. The manager lets you:

- add and edit custom skills;
- choose whether a skill is visible to **Only me** or **Everyone** when you have the required authority;
- turn **Use automatically** on or off;
- delete custom skills after confirmation;
- view bundled, instance-wide, and personal skills separately.

Bundled skills are read-only. Administrators can manage instance-wide skills and, where appropriate, other accounts' custom skills; ordinary accounts can manage their own personal skills. These UI controls do not override the live plugin grants or tool policy used by the loader.

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

The `description` is required for automatic discovery. A skill without one can still be loaded by exact name, but it cannot give the model a useful trigger and Elowen logs a warning. You may add:

```yaml
disable-model-invocation: true
```

to make the skill manual only. Relative paths in a skill's instructions resolve from the skill directory: the directory containing the flat file, or the directory containing `SKILL.md` for the directory form.

## Ownership and path safety

Skills can come from the Skills plugin or from another enabled plugin. A sibling plugin registers its skills into the same host catalog, so `SkillLoad`, automatic discovery, and `/skill:<name>` use the same grant- and ownership-filtered definition.

The host records the canonical base directory when a skill is registered. Before loading, it resolves the skill file and verifies that the resolved path remains inside that pinned directory. Missing files, unreadable files, and symlink or `..` paths that escape the registered boundary are rejected. A skill cannot use a later symlink change to redirect loading to an arbitrary host path.

Do not put secrets in a skill. Do not use a skill as a substitute for access control: a skill can describe a safe procedure, but the account's existing project, tool, and plugin permissions still apply.

## Troubleshooting

- **No Skills tools or picker:** enable the Skills plugin and check the account's plugin grant.
- **A sibling-plugin skill is missing:** confirm that plugin is enabled, its grant is present when it is grantable, and the skill is registered by that plugin.
- **The model never selects a skill:** improve its one-line description, or check that **Use automatically** is enabled.
- **`/skill:<name>` does not work:** use `ListSkills` or `/skills` to confirm the exact name and that the skill is available to the current account and current turn.
- **A skill is not advertised automatically:** verify the YAML frontmatter, a non-empty `description`, and the flat or directory layout above. An empty description prevents automatic discovery but does not prevent exact-name loading.
- **A new or edited skill is not visible yet:** send the next message after the plugin reload completes; current turns are not rewritten retroactively.

[Next: MCP Integration](mcp)
