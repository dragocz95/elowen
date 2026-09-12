# CLI Reference

The `elowen` command is the terminal client and local service manager for Elowen. The installed `elowen` and `elo` binaries use `dist/cli/bin.js`; a source checkout can run the built entry point with `node dist/cli/bin.js`.

## Requirements and authentication

The CLI requires Node.js `22.12` or newer. Interactive chat and login require a TTY. A token is resolved in this order:

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
| `elowen down [--force]` | Stop services gracefully; running turns are checkpointed rather than discarded. `--force`/`-f` skips the drain and kills immediately, abandoning whatever was running. |
| `elowen status` | Show daemon and Web UI process/health state. |
| `elowen restart <daemon\|web\|all>` | Queue a safe non-blocking restart of the selected managed service(s). |
| `elowen update` | Check for a newer npm release and restart in place. |
| `elowen menu` | Open the interactive service launcher. |

`elowen setup` runs the onboarding wizard on demand. For unattended installs it takes flags on the command line: `--reset`, `--non-interactive`, `--admin-user`, `--admin-password`, `--project`, `--project-slug`, `--no-project`, `--provider`, `--api-key`, `--base-url`, `--model`, `--memory` (one of `reuse`, `openrouter`, or `skip`), `--memory-key`, `--embedding-model`, `--skip-test`, and `--lsp`. Secrets can be supplied through the `ELOWEN_ADMIN_PASSWORD`, `ELOWEN_API_KEY`, and `ELOWEN_OPENROUTER_KEY` environment variables instead of the command line, which keeps them out of the process arguments.

Lifecycle commands manage services themselves and do not auto-start a second daemon. Only the API-backed commands (`api`, `chat`, `login`, and the `run`/`-p` family) auto-start a local unmanaged daemon, and `ELOWEN_AUTOSTART=0` disables that entirely. When the daemon is not running on a systemd-managed host, the probe refuses to spawn a stray daemon and tells the operator to start the service instead, for example with `systemctl start elowen-daemon elowen-web`.

On a systemd-managed installation, restart only the service you need or both services together:

```bash
elowen restart daemon   # daemon only
elowen restart web      # Web UI only
elowen restart all      # daemon and Web UI
```

The command maps to `systemctl restart --no-block` and returns once systemd has queued the job, before the selected service stops. `systemctl` is invoked directly when the CLI runs as root and through `sudo` otherwise. A blocking restart is refused by design because the caller may itself be running inside the daemon's own cgroup: systemd would stop the daemon while its graceful drain waits for the calling process, and the two wait on each other. `/restart` is the administrator-only in-chat equivalent for restarting the daemon itself; it drains active work and lets the supervisor bring it back.

## Interactive chat

Start a fresh conversation or deliberately resume an existing one:

```bash
elowen chat
elowen chat -c
elowen chat --session <session-id>
```

`elowen chat` starts a new conversation by default. `-c`/`--continue` continues the conversation associated with the current working directory. `--session` selects a specific conversation. The conversation remains stored in SQLite and can also be opened by the Web UI.

The TUI streams assistant text, reasoning (when shown), tool calls and output, diffs, images, approval questions, queued messages, goals, delegated sub-agents, and workflow state. On terminals wide enough for it, the right-hand **telemetry rail** shows live context usage (tokens, percentage, and cost), active goals, provider limits, workflows, sub-agents, background processes, project path and branch, connected MCP servers, and LSP state. Use `Ctrl+P` to show or hide the rail; click or use the mouse wheel to fold sections, inspect running workflows, switch process views, or stop a background process. Its width fits the current content within a bounded range, and the rail is hidden automatically when the terminal is too narrow.

Type `/` to open the command menu. The command catalog comes from `src/brain/slashCommands.ts` and is filtered by surface, administrator status, and loaded plugins. The former browser terminal route has been removed; use `elowen chat` for the terminal TUI, or `/chat` in the Web UI for browser-based chat.

### Input features

- `!command` runs `command` locally in the CLI's current working directory. Its output is displayed and buffered as context for the next prompt; it is not sent as the user's message.
- `@path` attaches a path under the current working directory. Text files are inserted as context; PNG, JPEG, GIF, and WebP files are sent as images.
- `@clipboard` and `/paste` attach an image from the system clipboard using `xclip`, `wl-paste`, or macOS `pngpaste`.
- Text attachments are limited to `256 KiB`; images are approximately limited to `5 MB`; a message can contain at most four images.
- `/cd [path]` reports or changes the CLI process working directory. It affects later shell commands, attachments, exports, and local prompt history, but it does not grant access to another daemon Project.
- `/editor` suspends the TUI and opens `$VISUAL`, then `$EDITOR`, falling back to `vi`. A non-zero editor exit preserves the original draft.

### Key bindings

Shortcuts live in two layers. A small set of structural keys is fixed on purpose and cannot be rebound: `Ctrl+D`, `Ctrl+L`, `Ctrl+R`, and `Ctrl+U` keep their meaning inside modals such as the rename and delete pickers, and Escape, Enter, Backspace, Tab, the arrow keys, Page Up, and Page Down remain plain editor and navigation keys.

Everything else resolves through named actions:

| Action | Default |
| --- | --- |
| Leader prefix | `Ctrl+X` |
| Quit | `Ctrl+C` or `Ctrl+Z` |
| Cycle work mode (build, plan, workflow) | `Shift+Tab` or `Ctrl+Tab` |
| Cycle reasoning level | `Ctrl+R` |
| Stash the current draft, or restore the last one | `Ctrl+S` |
| Cycle parent and sub-agent views | `Ctrl+O` |
| Background foreground work (sub-agents, workflows, commands) | `Ctrl+B` |
| Show or hide the telemetry rail | `Ctrl+P` |
| Remove the last queued message | `Ctrl+X` then `x` |
| Help | `Ctrl+X` then `h` |
| Theme picker | `Ctrl+X` then `t` |
| Model picker | `Ctrl+X` then `m` |
| Sessions picker | `Ctrl+X` then `l` |

Overrides live under `keybinds` in `cli-prefs.json`. A spec lists comma-separated alternatives; a direct chord combines `ctrl`, `shift`, `alt`, or `super` with a key; a leader sequence is written as `leader <key>`; and `none` unbinds the action. A direct binding must carry a real modifier, or be one of `f1` through `f12`, `pageup`, `pagedown`, or `insert`, or be exactly `shift+tab`; anything else is refused because it would shadow typing. After the leader chord the TUI waits two seconds for the second key. An invalid override keeps the default and warns, and when two actions resolve to the same chord the TUI warns about the unreachable one without changing which action wins.

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
| `/fast [on\|off\|status]` | Set or inspect your durable account Fast preference. Unsupported current routes keep the preference but receive no Fast wire field. |
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
| `/lsp` | Inspect or toggle language-server support; administrator-only, available when the lsp plugin is installed. |
| `/mcp` | Inspect MCP servers and reconnect health when the plugin is installed. |
| `/skills` | Inspect and load available skills when the plugin is installed. |
| `/tasks` | Inspect and manage this conversation's tasks when the todo plugin is installed. |
| `/tools` | Inspect active plugin tools and ownership. The catalog entry carries no administrator flag, so the command is offered to everyone, but the endpoint behind it is administrator-only and a non-administrator session receives an authorization error. |
| `/export [html\|jsonl]` | Save the current conversation in the launch directory. |
| `/restart` | Restart the daemon; administrator-only. |
| `/help` | Show the commands available to this CLI session. |
| `/quit` | Exit the TUI. |

`/cd`, `/paste`, and `/editor` belong to this command set too; they are described under Input features above. Platform-only controls, such as the channel `/voice` and `/display` commands, the `/project` channel re-key, and the platforms' own `/context` conversation picker, are not CLI commands. Plugin prompt macros are added to the menu by the running plugin and are sent to the brain as native slash prompts.

### Queue, interruption, and child sessions

Only one turn executes in a conversation at a time. Messages sent while it is working are queued durably and can survive a daemon restart. `Esc` with a non-empty queue injects the queued message immediately; the leader `x` shortcut removes the last queued message.

The default interrupt window is `1.8` seconds. Press `Esc` while a turn is running to arm interruption, then press it again within the window to abort. Escalation can terminate a pinned foreground command. `Ctrl+B` backgrounds foreground delegated work, workflows, or daemon shell commands without cancelling them. It also releases a blocking `ProcessOutput` read: the tool returns the output so far, marked as still running with the wait released, and the process is left for a later read.

`Ctrl+O` cycles between the parent conversation and child sub-agent views. While a child is selected, plain text steers that child; slash commands still act on the parent conversation.

## Modes, permissions, and plans

The current work mode is local to the interactive CLI process and is stamped onto subsequent sends. It is not stored as a channel mode and is not an additional permission grant.

- **Build** is the default and permits normal tool execution subject to account and per-call policy.
- **Plan** keeps the complete tool catalogue advertised for prompt-cache stability. Mutating tools are refused at execution time; `Write` and `Edit` may write only the current conversation's plan file under `$HOME/.config/elowen/plans/`. Plan mode is a policy guard, not an operating-system sandbox.
- **Workflow** asks the brain to orchestrate a directed acyclic graph of scoped sub-agents. Independent nodes can run in parallel; dependent nodes wait for prerequisites.

Tool access is resolved for the acting account and then checked again at execution time. Account grants and disabled tools are separate from ordered `allow`/`ask`/`deny` rules. Interactive `ask` rules pause for approval. Channel, scheduled, and delegated turns have no approval UI and follow the account's unattended-ask policy. `/yolo` auto-approves an interactive ask but never overrides a deny rule or strict unattended denial.

A delegated child inherits or narrows its parent's effective authority and cannot widen it. The same rule applies to every workflow node. `DelegateContinue` resumes the existing child transcript rather than creating an unrestricted copy.

### Deferred tools and ToolSearch

Large plugin and MCP tool sets may be deferred to keep the model prompt small. Deferred tools appear by name in the session's tool-awareness block, but their parameter schemas are withheld and they cannot be called until activated. The brain's `ToolSearch` tool loads them for the next model step of the same user turn:

```text
ToolSearch({"query":"select:DiscordCreateChannel,mcp__github__create_issue","max_results":5})
ToolSearch({"query":"discord channel","max_results":5})
ToolSearch({"query":"+github create","max_results":5})
```

Both `query` and `max_results` are required. `max_results` defaults to `5` in the schema and limits keyword results up to the hard safety cap of `25`. `select:<name>[,<name>...]` fetches exact names and ignores the keyword limit, while still obeying the hard cap; a bare exact name also works. A keyword query searches tool names, descriptions, and parameter names, while `+term` makes a term required. Already active tools should be called directly. ToolSearch activation is permission-filtered and does not grant access; normal account, plugin, and execution-time policy checks still apply.

Where an embedding model is configured, keyword results are also ranked by meaning: the semantic contribution is weighted so a strong semantic match outranks a description-word hit but never a name hit, and any failure of that layer degrades to keyword-only ranking. Candidates are filtered by the acting account's policy before ranking, so a tool the account may not use cannot consume the result budget. Matching skills are reported in the same answer, at most three, as a pointer naming `SkillLoad` rather than being activated, and that pointer is included even when no tool matched.

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
| `--model <provider/model>` | Select a canonical provider/model pair, such as `anthropic/claude-sonnet`; a bare model id is also accepted. |
| `--provider <id>` | Select the provider separately when `--model` contains only a model id. |
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

Defaults: a run continues the active conversation rather than starting a fresh one, uses `build` mode, writes plain text to stdout, stays quiet, and times out after `600` seconds. Output has exactly two modes, plain text and JSONL events through `--json`, and `--verbose` is an orthogonal stderr channel on top of plain-text output. The CLI installs `EPIPE` handlers, so a piped run exits `0` when the consumer closes the pipe.

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
