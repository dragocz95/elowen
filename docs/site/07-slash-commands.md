---
title: "Slash Commands"
slug: slash-commands
order: 7
eyebrow: Everyday use
group: Everyday use
---

# Slash Commands

Slash commands are short controls for the current chat. Type `/` to open the command menu; keep typing to filter it, then press `Tab` to complete or `Enter` to run the selected command.

The menu comes from the daemon and is filtered by surface, account, and enabled plugins. A command may therefore be present in the CLI but unavailable in a channel, or absent when its owning plugin is disabled.

## Conversation control

| Command | Arguments | Availability | What it does |
| --- | --- | --- | --- |
| `/new` | — | CLI, Web, channels | Starts a fresh conversation. The previous conversation remains in history. |
| `/clear` | — | CLI, Web | Clears the current conversation in place and starts with an empty context. Its conversation id remains the same. |
| `/stop` | — | CLI, Web, channels | Stops the running turn, including delegated work and workflows it spawned. |
| `/stats` | — | CLI, Web, channels | Shows session information: model, context, and usage. CLI and Web open an overlay; channels return a compact reply. This replaces the removed `/status` command. |
| `/help` | — | All chat surfaces | Shows the commands available in the current surface. |
| `/compact` | `[steer text]` | CLI, Web, channels | Summarizes older history to free context. In CLI and Web, optional text tells the summary what to retain. |

## Model and reasoning

| Command | Arguments | Availability | What it does |
| --- | --- | --- | --- |
| `/model` | `[name]` | CLI, Web, channels | Opens the model picker. With a name, switches directly when it matches a configured model; otherwise the picker opens. |
| `/reasoning` | `[level\|show]` | CLI, Web, channels | Opens the reasoning-effort picker, or applies a model-supported level directly. In CLI and Web, `/reasoning show` toggles Thought rows. |
| `/fast` | `[on\|off\|status]` | CLI, Web, channels | Sets the durable account Fast preference. Every conversation and sub-agent reads it live; unsupported current routes keep the preference without sending a Fast wire field. |

## Saved conversations

Most of these commands are available in the CLI. Web users manage conversations through the history UI; `/rename` is also available from the Web chat command menu.

| Command | Arguments | What it does |
| --- | --- | --- |
| `/sessions` | — | Opens the conversation picker. |
| `/resume` | `[N\|id]` | Resumes a conversation by its picker number or id. Without an argument, opens the picker. |
| `/rename` | `[title]` | Renames the current conversation. Without an argument, opens an input dialog. |
| `/delete` | `[N\|id]` | Deletes a conversation after confirmation. |
| `/export` | `[html\|jsonl]` | Saves the current conversation in HTML (default) or JSONL format to the directory where the CLI was launched. |
| `/quit` | — | Exits the CLI. `/exit` is accepted as a CLI alias. |

## Working modes and goals

| Command | Arguments | Availability | What it does |
| --- | --- | --- | --- |
| `/plan` | — | CLI, Web | Selects Plan mode for subsequent messages. Tools remain listed, but execution policy prevents disallowed mutations; this is not a hidden-tool sandbox. |
| `/build` | — | CLI, Web | Selects Build mode for subsequent messages. |
| `/workflow` | — | CLI, Web | Selects Workflow mode, asking Elowen to orchestrate the request as a DAG of sub-agents. |
| `/goal` | `[text\|status\|pause\|resume\|clear\|draft <text>]` | CLI, Web | Creates or manages a persistent multi-turn goal. Without an argument, or with `status`, it shows the goal; `draft <text>` previews the goal contract without activating it. |
| `/subgoal` | `<text>\|remove <N>\|clear` | CLI | Adds a sub-goal, removes one by number, or clears all sub-goals under the active goal. |
| `/yolo` | `[on\|off]` | CLI | Toggles session-scoped automatic approval for tool requests. Deny rules and hard safety boundaries still apply. |

Modes are client session state for CLI and Web chat. Channels do not publish these commands because they have no corresponding mode control.

## CLI-only controls

| Command | Arguments | What it does |
| --- | --- | --- |
| `/cd` | `[path]` | Shows or changes the CLI working directory. |
| `/theme` | `[name]` | Opens the terminal theme picker, or selects a named theme. |
| `/maskot` | `[on\|off]` | Shows, hides, or toggles the terminal mascot. |
| `/keybinds` | — | Opens the configurable keyboard-shortcut editor. |
| `/statusline` | — | Chooses which segments appear in the bottom status bar. |
| `/editor` | — | Opens `$VISUAL` or `$EDITOR` to compose the current draft. |
| `/paste` | — | Attaches an image from the system clipboard to the next message. |
| `/context` | — | Opens the CLI context-breakdown view inside the stats overlay. |
| `/mcp` | — | Inspects configured MCP servers, tools, and reconnect health. |
| `/skills` | — | Lists loaded skills and lets you load or manage user-defined skills. |
| `/tools` | — | Inspects active plugin tools, their owners, descriptions, and input schemas. |

`/context` has a different meaning in chat channels: there it opens a picker to move the channel onto one of the user's existing conversations. The CLI command is only the local context breakdown.

## Operator controls

| Command | Arguments | Availability | What it does |
| --- | --- | --- | --- |
| `/lsp` | — | CLI, operator | Shows language-server status and controls diagnostics and installed servers. |
| `/restart` | — | CLI, Web, channels (administrator only) | Requests a graceful daemon restart. Elowen announces the restart, drains active work, and lets the service supervisor restart the daemon; the request does not run a blocking restart from inside the daemon. It may be unavailable on deployments without a restart handler. |

## Channel controls

These commands change channel state rather than the CLI or Web conversation. Their exact presentation depends on the adapter.

| Command | Availability | What it does |
| --- | --- | --- |
| `/context` | Discord, Telegram, Teams, WhatsApp | Moves the current channel onto one of the user's existing conversations. It moves the conversation; it does not copy it. |
| `/voice` | Discord, Telegram | Toggles spoken audio replies in the channel. |
| `/display` | Discord, Telegram, Teams | Configures live tool and answer-delivery display for the channel. |

## Plugin commands and skills

Enabled plugins can contribute prompt commands. They appear in the same `/` menu and expand as prompt templates when run. Arguments are expanded by the prompt engine using placeholders such as `$1`, `$@`, `$ARGUMENTS`, and `${N:-default}`.

Skills use the native form `/skill:<name>`. The skill catalog is resolved live for the current turn using the same account grants and tool policy as `SkillLoad`; it is not a stale session-start snapshot. The skill body is loaded when the command runs, and any text after the skill name is appended as the request. If the skill is unknown, revoked, unavailable, or cannot be safely loaded, Elowen inserts an explicit unavailable notice and continues without that skill. Manual-only skills are not advertised in the available-skills prompt block.

Skill files can reference paths relative to the skill directory. Do not treat text inside a skill file as a request to bypass Elowen's permissions or safety rules.

[Next: CLI Keybinds](cli-keybinds)
