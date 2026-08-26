# CLI Reference

The `elowen` command is the terminal client and local service manager for Elowen. The installed `elowen` and `elo` binaries use `dist/cli/bin.js`; a source checkout can run the built entry point with `node dist/cli/bin.js`.

## Requirements and authentication

The CLI requires Node.js `22` or newer. Interactive chat and login require a TTY. A token is resolved in this order:

1. `ELOWEN_TOKEN` from the environment;
2. the cached token in `$HOME/.config/elowen/cli.json`;
3. an interactive login when `elowen chat` is run from a TTY.

`elowen login` explicitly performs the login flow and writes the token cache with mode `0600`. A failed or revoked token is removed from the cache. Keep the cache outside the npm package; package updates do not replace it.

The CLI sends `Authorization: Bearer <token>` directly to the daemon. The Web UI uses a separate same-origin cookie/BFF flow; do not copy the CLI token approach into browser code.

## Command overview

| Command | Purpose |
| --- | --- |
| `elowen` | Open a fresh interactive chat when stdin is a TTY; otherwise print help. |
| `elowen chat` | Open interactive terminal chat. |
| `elowen run <prompt>` | Run one non-interactive turn, slash command, or goal. |
| `elowen -p <prompt>` | Alias for `run`; `--print` is also accepted. |
| `elowen login` | Log in and cache a CLI token. |
| `elowen api <METHOD> <path> [json]` | Call any daemon API route with the current token. |
| `elowen setup` | Run local first-time setup. |
| `elowen doctor` | Run a read-only readiness check. |
| `elowen install` | Provision a shared installation; inspect `elowen install --help` first. |
| `elowen uninstall` | Remove what `install` created; data is retained unless purge is requested. |
| `elowen up` | Start the daemon and Web UI. |
| `elowen down [--force]` | Stop services gracefully, or immediately with `--force`/`-f`. |
| `elowen status` | Show daemon and Web UI process/health state. |
| `elowen update` | Check for a newer npm release and restart in place. |
| `elowen menu` | Open the interactive service launcher. |

Lifecycle commands manage services themselves and do not auto-start a second daemon. API-backed commands may auto-start a local unmanaged daemon unless `ELOWEN_AUTOSTART=0` is set.

## Interactive chat

Start a fresh conversation or deliberately resume an existing one:

```bash
elowen chat
elowen chat -c
elowen chat --session <session-id>
```

`elowen chat` starts a new conversation by default. `-c`/`--continue` continues the conversation associated with the current working directory. `--session` selects a specific conversation. The conversation remains stored in SQLite and can also be opened by the Web UI.

The TUI streams assistant text, reasoning (when shown), tool calls and output, diffs, images, approval questions, queued messages, goals, delegated sub-agents, and workflow state. Type `/` to open the command menu. The command catalog comes from `src/brain/slashCommands.ts` and is filtered by surface, administrator status, and loaded plugins.

### Input features

- `!command` runs `command` locally in the CLI's current working directory. Its output is displayed and buffered as context for the next prompt; it is not sent as the user's message.
- `@path` attaches a path under the current working directory. Text files are inserted as context; PNG, JPEG, GIF, and WebP files are sent as images.
- `@clipboard` and `/paste` attach an image from the system clipboard using `xclip`, `wl-paste`, or macOS `pngpaste`.
- Text attachments are limited to `256 KiB`; images are approximately limited to `5 MB`; a message can contain at most four images.
- `/cd [path]` reports or changes the CLI process working directory. It affects later shell commands, attachments, exports, and local prompt history, but it does not grant access to another daemon Project.
- `/editor` suspends the TUI and opens `$VISUAL`, then `$EDITOR`, falling back to `vi`. A non-zero editor exit preserves the original draft.

### Slash commands

The following built-in commands are available to the CLI when their required plugin or administrator access is present:

| Command | Behavior |
| --- | --- |
| `/new` | Start a fresh conversation. |
| `/clear` | Empty the current conversation while keeping its identity. |
| `/stop` | Stop the running turn. |
| `/stats` | Open session, model, usage, and context information. |
| `/context` | Open the same information directly on the context breakdown. |
| `/sessions` or `/resume` | Pick a stored conversation; an argument selects an id or list number. |
| `/rename [title]` | Rename the current conversation. |
| `/delete` | Pick and confirm deletion of a conversation. |
| `/model [id]` | Pick a model or switch directly by id. |
| `/reasoning [level]` | Pick or set a model-supported reasoning level. `/reasoning show` toggles Thought rows. |
| `/fast [on\|off]` | Toggle OpenAI OAuth priority processing or set it explicitly. |
| `/plan` | Use plan mode for subsequent turns. |
| `/build` | Use build mode for subsequent turns. |
| `/workflow` | Use workflow mode for subsequent turns. |
| `/goal` | Create, inspect, pause, resume, or clear a persistent goal. |
| `/subgoal` | Add or remove a persistent-goal subgoal. |
| `/compact [guidance]` | Summarize older conversation context. |
| `/yolo [on\|off]` | Toggle session-level automatic approval where policy permits it. |
| `/theme` | Pick or set the terminal color theme. |
| `/maskot [on\|off]` | Show or hide the local terminal mascot. |
| `/keybinds` | Inspect and edit configurable shortcuts. |
| `/statusline` | Choose fields in the bottom status line when the plugin is installed. |
| `/lsp` | Inspect or toggle language-server support when the plugin is installed and access permits it. |
| `/mcp` | Inspect MCP servers and reconnect health when the plugin is installed. |
| `/skills` | Inspect and load available skills when the plugin is installed. |
| `/tools` | Inspect active plugin tools and ownership. |
| `/export [html\|jsonl]` | Save the current conversation in the launch directory. |
| `/restart` | Restart the daemon; administrator-only. |
| `/help` | Show the commands available to this CLI session. |
| `/quit` | Exit the TUI. |

Platform-only controls such as channel voice/display commands are not CLI commands. Plugin prompt macros are added to the menu by the running plugin and are sent to the brain as native slash prompts.

### Queue, interruption, and child sessions

Only one turn executes in a conversation at a time. Messages sent while it is working are queued durably and can survive a daemon restart. `Esc` with a non-empty queue injects the queued message immediately; the leader `x` shortcut removes the last queued message.

The default interrupt window is `1.8` seconds. Press `Esc` while a turn is running to arm interruption, then press it again within the window to abort. Escalation can terminate a pinned foreground command. `Ctrl+B` backgrounds foreground delegated work, workflows, or daemon shell commands without cancelling them.

`Ctrl+O` cycles between the parent conversation and child sub-agent views. While a child is selected, plain text steers that child; slash commands still act on the parent conversation.

## Modes, permissions, and plans

The current work mode is local to the interactive CLI process and is stamped onto subsequent sends. It is not stored as a channel mode and is not an additional permission grant.

- **Build** is the default and permits normal tool execution subject to account and per-call policy.
- **Plan** keeps the complete tool catalogue advertised for prompt-cache stability. Mutating tools are refused at execution time; `Write` and `Edit` may write only the current conversation's plan file under `$HOME/.config/elowen/plans/`. Plan mode is a policy guard, not an operating-system sandbox.
- **Workflow** asks the brain to orchestrate a directed acyclic graph of scoped sub-agents. Independent nodes can run in parallel; dependent nodes wait for prerequisites.

Tool access is resolved for the acting account and then checked again at execution time. Account grants and disabled tools are separate from ordered `allow`/`ask`/`deny` rules. Interactive `ask` rules pause for approval. Channel, scheduled, and delegated turns have no approval UI and follow the account's unattended-ask policy. `/yolo` auto-approves an interactive ask but never overrides a deny rule or strict unattended denial.

A delegated child inherits or narrows its parent's effective authority and cannot widen it. The same rule applies to every workflow node. `DelegateContinue` resumes the existing child transcript rather than creating an unrestricted copy.

## Non-interactive runs

`run` starts or resumes a conversation, streams one turn or command, and exits:

```bash
elowen run "summarize the failing tests"
elowen -p "review this diff"
elowen run --new "start a clean investigation"
elowen run --resume <session-id> "continue"
elowen run --mode plan "propose a migration"
elowen run --goal "finish the cleanup" --max-turns 12
```

Options:

| Option | Meaning |
| --- | --- |
| `--model <id>` | Select the model. |
| `--provider <id>` | Select the provider. |
| `-c`, `--continue` | Continue the active/current-directory conversation (the default). |
| `--session <id>`, `--resume <id>` | Select a specific conversation. |
| `--new` | Start a fresh conversation. |
| `--mode plan\|build\|workflow` | Select the turn mode. |
| `--plan` | Shorthand for `--mode plan`. |
| `--goal <text>` | Start a persistent goal instead of a single turn. |
| `--max-turns <N>` | Set the goal's positive integer turn budget. |
| `--list` or `--sessions` | Print conversations and exit. |
| `--json` | Emit JSONL events to stdout. |
| `--verbose` | Print steps, tools, and notices to stderr in plain-text mode. |
| `--timeout <seconds>` | Set the whole-command timeout; default `600` seconds. |

A bare positional argument is treated as the prompt. A prompt beginning with `/` runs a slash command, for example `elowen -p "/compact"` or `elowen -p "/goal pause"`. Headless mode cannot answer interactive questions: it reports `[needs input]` and exits.

Exit codes from `elowen run` are:

| Code | Meaning |
| --- | --- |
| `0` | Turn or goal completed successfully. |
| `1` | Runtime, transport, or provider error. |
| `2` | Invalid command-line usage. |
| `3` | Goal paused or exhausted its budget. |
| `4` | Goal became blocked. |
| `5` | The turn asked for interactive input. |
| `124` | The command timeout elapsed. |

## Generic API access

Use `elowen api` when no dedicated CLI operation exists:

```bash
elowen api GET /projects
elowen api GET /brain/status
elowen api POST /some/route '{"key":"value"}'
```

The optional body must be valid JSON. The command prints formatted JSON when the response is JSON, returns exit code `0` for a successful HTTP response, and returns `1` for an API error. `ELOWEN_URL` selects the daemon URL and defaults to `http://localhost:4400`.

## Local state and environment

The default state directory is `$HOME/.config/elowen`:

| Path or variable | Purpose |
| --- | --- |
| `cli.json` | Cached bearer token, written with mode `0600`. |
| `cli-prefs.json` | Local theme, Thought-row and mascot visibility, keybindings, and locale. |
| `cli-history.json` | Per-project prompt history; default depth `100`, range `20–1000`. |
| `cli-mentions.json` | Per-project file-mention frecency. |
| `plans/<slug>.md` | Active conversation plan files. |
| `ELOWEN_DB` | Override the SQLite database path. |
| `ELOWEN_LOG_DIR` | Override the log directory. |
| `ELOWEN_URL` | Override the daemon base URL for CLI API calls. |
| `ELOWEN_TOKEN` | Supply a token without reading the cache. |
| `ELOWEN_AUTOSTART=0` | Prevent API-backed CLI commands from starting an unmanaged local daemon. |

The CLI's per-user terminal settings are stored by the daemon through `GET/PATCH /auth/me/terminal-settings`. The local preferences file remains device-local; the account's brain settings and model defaults are stored server-side.

## Implementation and testing

The interactive client is composed under `src/cli/chat/`: `ChatApplication` owns the TUI lifetime, `commands.ts` handles submission and slash dispatch, `keys.ts` owns configurable shortcuts, and `headless.ts` implements `run`/`-p`. `src/cli/index.ts` dispatches top-level commands and lifecycle behavior. `src/tmux/` is a separate driver for spawned external processes; the interactive TUI itself does not require tmux.

Useful checks are:

```bash
npm run build
npm test
npm run typecheck
npm run test:cli-tmux
```

For the public operator guide, see [`docs/site/06-cli.md`](site/06-cli.md) and [`docs/site/08-cli-keybinds.md`](site/08-cli-keybinds.md). For HTTP route details, see [`API.md`](API.md).
