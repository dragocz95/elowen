---
title: CLI Keybinds
slug: cli-keybinds
order: 8
eyebrow: Everyday use
group: Everyday use
---

# CLI Keybinds

The CLI has two kinds of keyboard input:

- **Configurable actions** are the named shortcuts listed below. Change them with `/keybinds`.
- **Structural and modal keys** keep the editor and pickers usable and are not part of the configurable keymap.

## Open the editor

In CLI chat, run `/keybinds`. The centered editor lists every configurable action and its effective chord.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move through actions |
| `Enter` | Capture a new chord for the selected action |
| `x` or `Delete` | Unbind the selected action |
| `r` | Reset the selected action to its default |
| `Esc` | Close the editor or cancel capture |

To create a leader sequence, press `Enter`, then press the leader chord (`Ctrl+X` by default), then the second key. The editor applies each valid change immediately and persists it without restarting the CLI.

## Configurable actions

| Action | Default | Behavior |
| --- | --- | --- |
| `leader` | `Ctrl+X` | Prefix for leader sequences. |
| `quit` | `Ctrl+C`, `Ctrl+Z` | Exit the CLI TUI. These do not mean “interrupt the current turn.” |
| `mode_toggle` | `Shift+Tab`, `Ctrl+Tab` | Cycle Build → Plan → Workflow → Build. |
| `reasoning_cycle` | `Ctrl+R` | Cycle through the active model's reasoning-effort levels. |
| `stash` | `Ctrl+S` | Stash the current draft; with empty input, restore the latest draft. The stack is session-local and holds up to 10 drafts. |
| `subagent_cycle` | `Ctrl+O` | Cycle focus through the parent conversation and child sub-agent sessions. |
| `subagent_background` | `Ctrl+B` | Move foreground sub-agents, workflows, and shell commands to the background. With no such work, the chord remains available to the text editor. |
| `telemetry_toggle` | `Ctrl+P` | Show or hide the telemetry rail. |
| `queue_remove` | `leader x` | Remove the last queued message. |
| `help` | `leader h` | Open the command help picker. |
| `theme_picker` | `leader t` | Open the terminal theme picker. |
| `model_picker` | `leader m` | Open the model picker. |
| `sessions_picker` | `leader l` | Open the conversation picker. |

`mode_toggle` is not limited to Plan and Build: it includes Workflow. `subagent_cycle` changes child-session focus, not merely a panel selection.

## Fixed editor and navigation keys

These keys are handled by the editor, overlays, or terminal input protocol rather than by `/keybinds`:

| Key | Behavior |
| --- | --- |
| `Enter` | Send the draft, confirm a picker choice, or submit a dialog. |
| `Esc` | Close an overlay, cancel capture, or participate in the two-press turn-interrupt flow. |
| `↑` / `↓` | Recall prompt history when the input is empty; otherwise navigate a picker. |
| `Tab` | Complete a slash command or file mention. |
| `PageUp` / `PageDown` | Scroll the transcript. |
| Mouse wheel | Scroll the transcript or the panel under the pointer. |
| Mouse click | Expand transcript rows, open sub-agents and workflows, or fold rail sections. |

While the agent is thinking, press `Esc` once to arm an interrupt and again within the default `1.8 seconds` to abort the turn. `Ctrl+B` is only claimed by the background action when there is foreground work to detach; otherwise it keeps the editor's normal behavior.

Some picker operations also have fixed modal-local controls. For example, the model picker uses `Ctrl+P` for provider management, the conversation picker uses `Ctrl+R` to rename and `Ctrl+D` to delete, and the skills picker uses `Ctrl+L` to load and `Ctrl+D` to delete. These do not change the global keymap.

## Chord syntax

Bindings use a compact specification:

- **Direct chord:** modifiers and a base key, such as `Ctrl+R`, `Alt+Enter`, `F2`, or `Shift+Tab`.
- **Alternative chords:** comma-separated alternatives, such as `Ctrl+C,Ctrl+Z`.
- **Leader sequence:** `leader` followed by a key, such as `leader t`.
- **Unbound:** `none`.

Supported modifiers are `ctrl`, `shift`, `alt`, and `super`. Direct bindings must use a safe modifier or a non-typing key; this prevents a shortcut from consuming ordinary text input. A leader sequence waits up to two seconds for its second key.

A chord can resolve to only one action. If overrides collide, the earlier action in the action list wins and the CLI displays a warning. Fix the collision in `/keybinds`, or unbind one action.

## Persistence

Overrides are stored in:

```text
$HOME/.config/elowen/cli-prefs.json
```

The `keybinds` value maps action names to chord specifications:

```json
{
  "keybinds": {
    "quit": "ctrl+q",
    "model_picker": "ctrl+k"
  }
}
```

Only custom values are stored. Resetting an action to its default removes its override. To reset all custom bindings, remove the `keybinds` property from `cli-prefs.json`.

[Next: Brain & Chat](brain-chat)
