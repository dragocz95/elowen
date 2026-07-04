---
title: Brain & Chat
slug: brain-chat
order: 7
eyebrow: Guide
---

# Brain & Chat

Orca has a built-in **brain** — an AI assistant that powers chat, automation,
plugins, skills, memory, and cron. You can talk to it via the web dock, the
CLI, or Discord.

![Screenshot of the Orca AI chat](images/brain-chat.png)

## Architecture

The brain is a multi-provider AI engine built on the PI Agent SDK:

| Component | Purpose |
|-----------|---------|
| **BrainService** | Per-user lifecycle — start, stop, status |
| **PlatformOrchestrator** | Routes messages through providers, tools, and plugins |
| **ChannelSessionService** | Per-channel session management (web, CLI, Discord) |
| **LiveSessionRegistry** | Tracks active brain sessions |
| **PluginRegistry** | Loaded plugins, tools, skills, and context providers |

## Chat interfaces

### Web dock

The advisor (per-user assistant) is a resizable side panel in the web
UI. Two modes:

- **Chat** — talk to the brain directly, with conversation history, tool call
  traces, model picker, and auto-compact
- **Terminal** — each pane is a tmux-spawned assistant or a live session view

### CLI chat

```bash
orca chat                  # start interactive chat
orca chat --new            # fresh conversation
orca chat --session <id>   # resume past conversation
```

The CLI chat features an opencode-style layout with tool glyphs, status bar,
and inline diffs.

### Discord

The Discord plugin connects the brain to your server — see [Plugins](plugins).

## Conversations

The brain supports multi-session conversations:

- **New** — start fresh (gets a unique session ID)
- **Resume** — pick up a past conversation with full history
- **Search** — fulltext search across all past conversations

Conversations persist in SQLite and survive daemon restarts.

## Model catalog

The brain aggregates models from multiple sources:

| Source | Example |
|--------|---------|
| **Manual providers** — statically configured | OpenAI, Anthropic |
| **Auto-fetch** — fetched from provider API | `/v1/models` endpoint |
| **OAuth-connected accounts** | Anthropic, Copilot, OpenAI Connect |

Configure in **Settings → Brain**. Each provider has its own API key,
base URL, and model list.

## OAuth account connect

Link your existing AI subscriptions:

- **Anthropic** — use your Claude API key
- **GitHub Copilot** — use your Copilot subscription
- **OpenAI** — use your OpenAI account

Connected accounts appear as providers in the model picker.

## Memory

The brain can **remember** across conversations using a self-hosted mem0
server or compatible backend.

![Screenshot of the memory interface](images/brain-memory.png)

| Feature | Description |
|---------|-------------|
| **Auto-recall** | Relevant memories from past conversations are injected into context |
| **Auto-save** | Important facts are extracted and stored after each turn |
| **Categories** | Organize memories by workspace or topic (with LLM auto-classify) |
| **Glass-brain** | Visual memory map in the web UI — see connections between memories |

Configure in **Settings → Plugins → memory**.

## Personality

Each user can have a **personality** — a system prompt fragment that shapes
how the brain responds. Personalities are per-platform (different tone on
Discord vs CLI vs web) and per-user.

## Reasoning effort

Control how much the model "thinks" before answering:

| Level | Effect |
|-------|--------|
| `minimal` | Fast, direct answers |
| `low` | Some reasoning |
| `medium` | Balanced |
| `high` | Thorough |
| `xhigh` | Maximum reasoning |

Set per conversation in chat, per channel in Discord, or as a default in
your account settings.

[Next: Plugins](plugins)
