---
title: Brain & Chat
slug: brain-chat
order: 7
eyebrow: Guide
---

# Brain & Chat

## The agent you talk to

Orca **is** the brain. The brain is the embedded agent core you chat with — it
reasons, calls tools, edits files, runs commands, loads plugins and skills,
remembers what matters, and can even wake itself up on a schedule. Everything
else in the product — the [Dashboard, Kanban, Timeline and Sessions](web-ui) —
exists so you can *watch and steer* this agent. The brain is Orca's identity;
the dashboards are the window onto it.

You reach the same agent from four places: the **web dock**, the **CLI**,
**Discord**, and **WhatsApp**. Same reasoning, same tools, same memory — just a
different surface. And because Orca is modular to the core, every one of those
capabilities (each chat platform, each tool, memory, skills) is a plugin you can
add or remove. Nothing here is baked in; it's all [Plugins](plugins).

![The Orca brain chat, showing a conversation with tool-call traces](images/brain-chat.png)

## Architecture

Under the hood the brain is a multi-provider AI engine. You don't need this to
use it, but it helps to know how the pieces fit when you're configuring or
extending Orca:

| Component | Purpose |
|-----------|---------|
| **BrainService** | Per-user lifecycle — start, stop, status |
| **PlatformOrchestrator** | Routes each message through the right provider, tools, and plugins |
| **ChannelSessionService** | Per-channel session management (web, CLI, Discord, WhatsApp) |
| **LiveSessionRegistry** | Tracks active brain sessions |
| **PluginRegistry** | The loaded plugins, tools, skills, and context providers |

The important takeaway: it's a small, self-hosted engine with a clean, modular
design. Lightweight app, professional-grade code — you run the whole thing
yourself.

## Chat interfaces

The agent is the same everywhere; only the surface changes.

### Web dock

The web dock is a resizable side panel that follows you across the whole web UI,
so the agent is one click away no matter which module you're in. It has two
modes:

- **Chat** — talk to the brain directly, with full conversation history,
  tool-call traces so you can see exactly what it did, a per-conversation model
  picker, and auto-compact to keep long threads within context.
- **Terminal** — a live view onto a running agent session (a tmux-spawned
  worker or a [live session](web-ui)), for when you want to watch or intervene
  in real time.

### CLI chat

```bash
orca chat                  # start an interactive chat
orca chat --new            # fresh conversation
orca chat --session <id>   # resume a past conversation
```

The CLI chat uses an opencode-style layout: tool glyphs, a status bar, and
inline diffs when the agent edits files — the full agent, right in your
terminal. See [CLI](cli) for the complete command reference.

### Discord & WhatsApp

Both chat platforms are plugins. Add the Discord bot to bring the agent into
your server, or the WhatsApp plugin (built on Baileys) to chat from your phone.
Both support a **per-chat / per-channel model picker** and **streamed replies**,
so answers appear as they're generated. Setup for each lives in
[Plugins](plugins).

## Conversations

The brain keeps distinct, resumable conversations:

- **New** — start fresh; the conversation gets a unique session id.
- **Resume** — pick up any past conversation with its full history intact.
- **Search** — fulltext search across everything you've ever discussed.

Conversations persist in SQLite (`~/.config/orca/orca.db`) and survive daemon
restarts, so nothing is lost when you restart Orca.

## Model catalog

The model picker aggregates every model available to you from three sources:

| Source | Example |
|--------|---------|
| **Manual providers** — statically configured | OpenAI, Anthropic |
| **Auto-fetch** — pulled live from the provider API | `/v1/models` endpoint |
| **OAuth-connected accounts** | Anthropic, GitHub Copilot, OpenAI |

Configure it all in **Settings → Brain**. Each provider carries its own API key,
base URL, and model list, so you can mix and match freely.

## Connect your AI accounts (OAuth)

Rather than paste raw API keys, you can link your existing AI subscriptions
directly:

- **Anthropic** — your Claude account
- **GitHub Copilot** — your Copilot subscription
- **OpenAI** — your OpenAI account

Once linked, connected accounts show up as ordinary providers in the model
picker — pick their models per conversation just like any other.

## Memory

The agent **remembers** across conversations using a self-hosted mem0 server (or
any compatible backend), so context you shared last week is still there today.

![The Memory module — a glass-brain map of stored memories](images/brain-memory.png)

| Feature | Description |
|---------|-------------|
| **Auto-recall** | Relevant memories are injected into context at the start of a turn |
| **Auto-save** | Facts are extracted and stored after each turn |
| **Categories** | Memories organized by topic, with LLM auto-classification |
| **Glass-brain** | A visual memory map in the [Memory module](web-ui) — see how memories connect |

Configure the backend in **Settings → Memory** (and toggle the memory plugin in
**Settings → Plugins**). Clarity all the way through: you can see, merge, and
purge what the agent knows about you.

## Communication style

Each user can give the agent a **communication style** — a system-prompt fragment
that shapes its tone and behavior. Communication styles are **per-user and
per-platform**, so the agent can be terse and technical in the CLI, friendlier on
Discord, and formal on WhatsApp — all for the same underlying brain. Set yours in
your [account settings](web-ui#account).

## Reasoning effort

Control how hard the model thinks before it answers:

| Level | Effect |
|-------|--------|
| `minimal` | Fast, direct answers |
| `low` | Some reasoning |
| `medium` | Balanced |
| `high` | Thorough |
| `xhigh` | Maximum reasoning |

Set it per conversation in chat, per channel on Discord/WhatsApp, or as a default
in your [account settings](web-ui#account).

## Tools are per-user

What the agent can *do* is governed by Orca's RBAC. Under **Settings → Users**,
an admin can give each user a **different set of tools and permissions** — grant
one person the terminal and files tools while another gets chat only, and scope
each user to specific projects. The agent you chat with only ever wields the
tools you're allowed to use. See [Account & Security](account-security) for the
full model, and remember: every tool is itself a [plugin](plugins) you can grant
or revoke.

[Next: Plugins](plugins)
