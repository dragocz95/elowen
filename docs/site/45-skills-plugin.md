---
title: Skills Plugin
slug: skills-plugin
order: 45
eyebrow: Plugin reference
group: Plugin reference
---

# Skills Plugin

The `skills` plugin loads Markdown skills from disk and exposes them to the Elowen brain. It owns the live skill catalog every conversation sees, provides the four skill tools, and offers the Skills manager in the Web UI. What a skill is and how to write one is covered in [Skills](skills).

## Where it appears

The plugin appears in **Settings → Plugins** as an installed plugin, and its **Skills** panel in the plugin detail opens the manager for adding, editing and deleting skills. Skills are also managed from the skills workspace in the Web UI. The plugin contributes no slash command of its own; the host commands `/skill:name` and `/skills` resolve against the catalog this plugin maintains.

## Tools

| Tool | What it does |
| --- | --- |
| `SkillLoad` | Loads the complete Markdown body of one skill by exact name from the live catalog, with optional arguments the skill can place in its instructions. |
| `ListSkills` | Lists every skill visible in the current session, with name, scope tag, and the one-line description that says when it applies. |
| `CreateSkill` | Saves a reusable skill as a file the agent can load again in later conversations, requiring an explicit scope of `personal` or `instance`. |
| `DeleteSkill` | Permanently removes a saved skill by exact name, stopping it from being recalled from the next message onward. |

`CreateSkill` and `DeleteSkill` are loaded on demand rather than at startup. `SkillLoad` and `ListSkills` are treated as safe to run while Elowen is still planning. `SkillLoad` is the canonical loader: skills contributed by other enabled plugins reach the brain through the same catalog and the same tool.

When a skill takes input, `SkillLoad` passes the whole argument string to it, and quoted phrases stay one argument. The skill body decides where those arguments are placed.

All four tools resolve names against the live catalog. A stale or misspelled name is refused rather than guessed.

## Instance and personal skills

A skill saved with the `instance` scope is shared with every session on this Elowen instance. Writing that scope requires instance-operator authority, which all administrators have; an ordinary account's agent is refused. A skill saved with the `personal` scope belongs to the owning account alone and is loaded only into that account's own, direct and delegated sessions.

When a personal skill and an instance skill share a name, the personal definition takes precedence for that account. A skill can never shadow a bundled skill or another skill in the same scope; when Elowen reports a name collision, choose a different name. Creating a personal skill with a name that already exists in your personal set updates that skill. Accountless or shared work sees only instance skills, because personal skills are not exposed there.

Bundled skills ship read-only. In the manager you choose whether a skill is visible to **Only me** or **Everyone**, where you hold the authority, and whether it may be used automatically. Administrators can manage instance-wide skills and, where appropriate, other accounts' custom skills; ordinary accounts manage their own personal skills.

## How a skill becomes visible in a conversation

Elowen sees only each available skill's name and description. On a task that matches, it loads the full body with `SkillLoad`, or you load one explicitly with `/skill:name`. The catalog is live and resolved per turn: changes to grants, plugin availability, ownership, or the skill files themselves take effect on a later turn, and current turns are not rewritten retroactively.

A skill marked **manual only** keeps its body loadable by exact name but is omitted from automatic discovery, so the model never picks it on its own.

Other enabled plugins contribute their skills into the same catalog. They show up in `ListSkills` and load through `SkillLoad` under the same ownership and grant filtering, and disabling the contributing plugin removes its skills from the catalog.

A load that cannot succeed, because the skill is unknown, revoked or unreadable, fails closed and the agent is told the skill is unavailable.

## Per-user grant

The plugin is user-grantable. A non-administrator cannot use its tools, its Web UI panel, or the catalog until an administrator grants access under **Users → Granted plugins**. A skill contributed by another grantable plugin needs that plugin's grant as well. Administrators always retain access. Account tool policy can still deny `SkillLoad` independently of the grant.

The grant gates the plugin's gated surfaces. Prompt fragments, platform prompts, slash commands and hooks contributed by a plugin are not filtered by it.

## Where skills are stored

Each skill is a flat Markdown file or a directory containing a `SKILL.md`, together with any supporting files, and the plugin loads bodies only from the directory pinned when the skill was registered. Personal sets are kept apart per account. The manager marks each skill as bundled or custom, shows the owner as Everyone or Mine, and carries a manual-only badge where automatic use is switched off. The file format and front matter are described in [Skills](skills).

## Configuration

The plugin has no configuration fields. Its manifest declares no settings schema; behavior follows from the skill files themselves, the scope and manual-only flags on each skill, and the host skill system. There are no per-account settings either.

## Permissions and consent

The manifest declares that the plugin reads plugin stores and other plugins' controls, and nothing else: no mutating capabilities, no network. Enabling therefore asks for no capability consent. Path safety is enforced by the host: each skill's directory is pinned when it is registered, and a load that resolves outside that boundary, including through a symlink changed after registration, is rejected. Personal skill sets are an isolation boundary between accounts.

## Known limits

| Area | Limit |
| --- | --- |
| Names | Kebab-case, lowercase letters, digits and dashes, at most 64 characters; the name is also the file name |
| Storage | One flat Markdown file or one SKILL.md directory per skill, inside the directory pinned at registration |
| Bundled skills | Read-only; they cannot be shadowed or deleted through this plugin |
| Shadowing | Personal over instance only; never over bundled skills or within the same scope |
| Automatic use | Requires a description; a skill without one can still be loaded by exact name |
| Manual only | Omitted from automatic discovery but always loadable by exact name |
| Scope changes | Moving a skill between scopes moves its file to the other set |
| Grants | A sibling plugin's skill also needs that plugin's grant; prompt fragments and hooks are not filtered by any grant |
| Authority | A skill describes a procedure; it grants no permission the account does not already have |

[Next: Usage Statistics](stats-plugin)