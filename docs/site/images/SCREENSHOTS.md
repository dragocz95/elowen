# Product screenshot manifest

Public documentation screenshots are captured from a live Elowen instance and redacted before they are committed. They illustrate product behavior, not a real user's account, projects, tasks, memories, sessions, provider credentials, or usage data.

| Asset | Surface and state | Viewport | Alt text | Redaction |
| --- | --- | --- | --- | --- |
| `settings-overview.png` | Settings → System | 1600px desktop | Elowen System settings with the spatial section rail and service diagnostics | Identity, timestamp, ports, and service values replaced with demo-safe values. |
| `settings-models.png` | Settings → Models | 1600px desktop | Elowen model catalog with provider groups and enabled models | Identity, provider accounts, and model labels replaced with generic examples. |
| `account-settings.png` | Account → Elowen AI | 1600px desktop | Account control surface with Elowen AI preferences | Identity and provider/model values replaced with generic examples. |
| `web-ui-tasks.png` | Tasks with selected mission | 1600px desktop | Task workspace with a right-side task detail drawer | Task, mission, phase, project, model, time, and identity data replaced with fictional examples. |
| `brain-memory.png` | Memory with selected record | 1600px desktop | Memory workspace with a right-side memory detail drawer | Every memory, category, history item, identifier, URL, model label, and identity is fictionalized. |
| `../../screenshots/cli/16-gpt-limits.png` | Terminal chat with GPT-5.5 and telemetry | 956px terminal | GPT-5.5 terminal conversation with live context and subscription limits | Captured in a disposable English-only demo session; the prompt, reply, and working directory are non-sensitive. |

The CLI screenshots use a separate disposable demonstration session. Never capture a user's active transcript, tokens, API keys, absolute project paths, private task content, or production session identifiers. Existing `09-todos.png` and `11-subagent.png` are English-only demo captures for their respective interaction states.
