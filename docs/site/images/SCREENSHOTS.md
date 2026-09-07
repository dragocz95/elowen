# Product screenshot manifest

Every screenshot in the documentation is captured from a **disposable demo stack**, never from a
production instance: a throwaway SQLite database, a demo admin (`alex`), two fictional colleagues
(`jordan` and `sam`), three fictional repositories under `/srv/projects` (`acme-api`, `acme-web`,
`design-system`) and an English demo backlog. No real account, project, conversation, memory or
credential is ever loaded, so nothing needs redacting after the fact.

All assets are captured at **2560×1440**, with the UI language set to English. The manifest records asset provenance and alt text only; it does not certify that a current production build or public landing-site build has rendered these files. The current documentation refresh did not run a linked-browser capture or a landing build, so treat these images as disposable documentation assets until a future capture records the source commit, route fixture, plugin versions, and checked build.

The following existing PNGs are not referenced by the current numbered manual and are retained as unclassified assets rather than presented as current coverage: `web-ui-timeline.png`, `web-ui-tasks.png`, `web-ui-kanban.png`, `web-ui-escalations.png`, and `web-ui-sessions.png`.

## Web UI

| Asset | Surface and state | Status | Alt text |
| --- | --- | --- | --- |
| `web-ui-dashboard.png` | Dashboard (Home) | Referenced by current manual | Dashboard with the hero mini-cosmos, the trunk filament and the activity journal |
| `brain-memory.png` | Memory with a record selected | Referenced by current manual | Memory workspace with a right-side memory detail drawer |
| `brain-chat.png` | Chat with a technical conversation | Referenced by current manual | Elowen answering a question about a rounding bug in the web chat |
| `getting-started-chat.png` | Chat with the introduction conversation | Referenced by current manual | Elowen introducing its capabilities in the web chat |
| `projects-list.png` | Projects registry | Referenced by current manual | Project registry with paths, notes and read-only Git context |
| `projects-editor.png` | Editor plugin with an open file | Referenced by current manual | Optional Project Editor plugin with the project file tree and an open source file |
| `users-rbac.png` | Users directory | Referenced by current manual | User directory with roles, project boundaries and model permissions |
| `settings-overview.png` | Settings → System | Referenced by current manual | Elowen System settings with the section rail and service diagnostics |
| `settings-models.png` | Settings → Models | Referenced by current manual | Elowen model catalogue with provider groups and enabled models |
| `plugins-overview.png` | Settings → Plugins | Referenced by current manual | Installed plugins with their tools, platforms and health |
| `account-settings.png` | Account | Referenced by current manual | Account control surface with the owner's Elowen preferences |
| `web-ui-timeline.png` | No current numbered-manual reference | Unreferenced/unclassified | Asset retained for future provenance review |
| `web-ui-tasks.png` | No current numbered-manual reference | Unreferenced/unclassified | Asset retained for future provenance review |
| `web-ui-kanban.png` | No current numbered-manual reference | Unreferenced/unclassified | Asset retained for future provenance review |
| `web-ui-escalations.png` | No current numbered-manual reference | Unreferenced/unclassified | Asset retained for future provenance review |
| `web-ui-sessions.png` | No current numbered-manual reference | Unreferenced/unclassified | Asset retained for future provenance review |

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
