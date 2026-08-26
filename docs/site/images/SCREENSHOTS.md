# Product screenshot manifest

Every screenshot in the documentation is captured from a **disposable demo stack**, never from a
production instance: a throwaway SQLite database, a demo admin (`alex`), two fictional colleagues
(`jordan` and `sam`), three fictional repositories under `/srv/projects` (`acme-api`, `acme-web`,
`design-system`) and an English demo backlog. No real account, project, conversation, memory or
credential is ever loaded, so nothing needs redacting after the fact.

All assets are captured at **2560×1440**, with the UI language set to English.

## Web UI

| Asset | Surface and state | Alt text |
| --- | --- | --- |
| `web-ui-dashboard.png` | Dashboard (Home) | Dashboard with the hero mini-cosmos, the trunk filament and the activity journal |
| `brain-memory.png` | Memory with a record selected | Memory workspace with a right-side memory detail drawer |
| `brain-chat.png` | Chat with a technical conversation | Elowen answering a question about a rounding bug in the web chat |
| `getting-started-chat.png` | Chat with the introduction conversation | Elowen introducing its capabilities in the web chat |
| `projects-list.png` | Projects registry | Project registry with paths, notes and read-only Git context |
| `projects-editor.png` | Editor with an open file | Built-in code editor with the project file tree and an open source file |
| `users-rbac.png` | Users directory | User directory with roles, project boundaries and model permissions |
| `settings-overview.png` | Settings → System | Elowen System settings with the section rail and service diagnostics |
| `settings-models.png` | Settings → Models | Elowen model catalogue with provider groups and enabled models |
| `plugins-overview.png` | Settings → Plugins | Installed plugins with their tools, platforms and health |
| `account-settings.png` | Account | Account control surface with the owner's Elowen preferences |

## CLI (`../../screenshots/cli`)

The terminal captures come from the same kind of disposable session: the CLI runs against a scripted
mock daemon in a `168×42` tmux pane, inside a fictional `~/projects/acme-api` checkout. The
conversation — a rounding bug in a shopping cart — is authored, not recorded, so no real transcript,
token, key or project path can appear.

| Asset | State |
| --- | --- |
| `01-start.png` | The start screen of a fresh conversation |
| `02-tool-calls.png` | Tool calls with their result blocks |
| `03-thought.png` | The model's reasoning segment, expanded |
| `04-approval-edit.png` | Tool-permission prompt for an edit |
| `05-diff.png` | An applied edit as a line-numbered diff |
| `06-approval-touch.png` | Tool-permission prompt for a shell command |
| `07-yolo.png` | YOLO mode: tool calls run without asking |
| `08-plan-ready.png` | Plan mode with a finished plan awaiting approval |
| `09-todos.png` | The pinned checklist card above the status bar |
| `10-console-output.png` | A foreground shell run with its console output |
| `11-subagent.png` | A delegated sub-agent reporting live progress |
| `12-subagent-drillin.png` | Drilled into the sub-agent's own transcript |
| `13-theme-picker.png` | The terminal theme picker |
| `14-model-picker.png` | The model picker |
| `15-slash-autocomplete.png` | The slash-command menu |
| `16-gpt-limits.png` | The rail carrying live subscription limits |
| `17-workflow-modal.png` | Workflow view with the dependency tree and the selected node |
