---
title: "Slash Commands"
slug: slash-commands
order: 7
eyebrow: Everyday use
group: Everyday use
---

# Slash Commands

Slash commands are the fastest way to steer Elowen mid-conversation. The menu is served by the daemon, not by each client, so a command added once shows up on every surface it applies to — the [CLI](cli), the [web chat](web-ui), Discord, Telegram, WhatsApp, and Teams — always in sync. Most commands work everywhere; a few are limited to the surfaces that can actually present them, and the Surfaces column below says which.

Type `/` in any chat to browse the menu. It filters as you keep typing, so `/mod` narrows to `/model` before you finish the word.

## Chat control

| Command | Arguments | What it does | Surfaces |
| --- | --- | --- | --- |
| `/new` | — | Starts a fresh conversation in the current chat. | All |
| `/stop` | — | Aborts the running turn, including any delegated sub-agents and workflows it spawned. | All |
| `/status` | — | Shows the active model, context usage as a percentage, and token usage for the session. | All |
| `/help` | — | Lists the available commands. | All |
| `/compact` | `[steer text]` | Summarizes the conversation history to free up context. Optional steer text tells the summary what to keep. A friendly no-op when there is nothing to compact. | All |
| `/yolo` | `[on\|off]` | Toggles session-scoped auto-approve for tool calls. Deny rules still apply — yolo never overrides them. | CLI |

## Model and reasoning

| Command | Arguments | What it does | Surfaces |
| --- | --- | --- | --- |
| `/model` | `[name]` | Opens the model picker, or switches directly when you give a name — fuzzy matching accepted. | All |
| `/reasoning` | `[level\|show]` | Opens the reasoning-effort picker, or sets a level directly. `show` toggles Thought rows in the transcript. | CLI + channels |
| `/fast` | `[on\|off\|status]` | Toggles OpenAI OAuth priority processing for faster responses. | All |

## Sessions (CLI)

These manage saved conversations. They exist only in the CLI, where session switching lives.

| Command | Arguments | What it does |
| --- | --- | --- |
| `/sessions` | — | Opens the session picker. |
| `/resume` | `[N\|id]` | Resumes a session by list number or id. |
| `/rename` | `[title]` | Renames the current session. Without an argument, opens an inline modal. |
| `/delete` | `[N\|id]` | Deletes a session, with a two-step confirmation. |
| `/export` | `[html\|jsonl]` | Downloads the conversation to the directory the CLI was launched from. |
| `/quit` | — | Exits the CLI. |

## Modes and goals

| Command | Arguments | What it does | Surfaces |
| --- | --- | --- | --- |
| `/plan` | — | Switches to plan mode: read-only, with mutating tools hidden. | CLI, web |
| `/build` | — | Switches back to build mode. | CLI, web |
| `/workflow` | — | Switches to workflow mode, where work runs as a DAG of sub-agents. | CLI, web |
| `/goal` | `[text\|status\|pause\|resume\|clear\|draft]` | Manages a persistent multi-turn objective. `draft` previews the goal without activating it. | CLI |
| `/subgoal` | `<text>\|remove N\|clear` | Adds, removes, or clears sub-goals under the active goal. | CLI |

A mode lives in the client's own session state and is stamped on each message it
sends, so it only exists where there is a place to show which mode you are in —
the CLI and the web chat. The chat platforms have no such place, so they stay out.

## CLI environment

These tune the terminal client itself, so they exist only in the CLI. See [CLI Keybinds](cli-keybinds) for the keyboard side of the same surface.

| Command | Arguments | What it does |
| --- | --- | --- |
| `/cd` | `[path]` | Changes the working directory the agent operates in. |
| `/theme` | `[name]` | Switches the color theme. |
| `/keybinds` | — | Opens the keybinding reference. |
| `/statusline` | — | Configures the status line. |
| `/editor` | — | Composes the current message in `$VISUAL` or `$EDITOR`. |
| `/paste` | — | Attaches the clipboard image to the message. |
| `/stats` | — | Shows session statistics. |
| `/mcp` | — | Shows MCP server and tool health. |
| `/skills` | — | Lists loaded skills. |
| `/tools` | — | Lists tools contributed by plugins. |

## Admin

| Command | Arguments | What it does | Surfaces |
| --- | --- | --- | --- |
| `/lsp` | — | Shows language-server status. | CLI (admin) |
| `/restart` | — | Restarts the daemon. | All (admin) |

## Channel-only commands

A few commands are adapter-local: they configure how one channel behaves rather than the conversation itself.

| Command | Arguments | What it does | Surfaces |
| --- | --- | --- | --- |
| `/context` | — | Binds the channel to an existing conversation. This **moves** the conversation to the channel — it does not copy it. Operator-gated. | Channels |
| `/voice` | — | Toggles spoken replies via text-to-speech. | Discord, Telegram |
| `/display` | — | Sets per-channel display overrides. | Discord, Telegram, Teams |

## Plugin commands

[Plugins](plugins) can register their own slash commands. Each one is a prompt template: when you run it, the template expands and is sent as your message, with any arguments substituted into `$1`, `$2`, `$@`, or `$ARGUMENTS` placeholders.

Plugin commands appear in the `/` menu on every surface automatically — there is nothing extra to configure per channel.

> Exact command availability per channel — including channel-only commands and operator gates — is documented on each channel's own page. Start at [Channels](channels).

[Next: CLI Keybinds](cli-keybinds)
