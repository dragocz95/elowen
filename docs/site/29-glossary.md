---
title: Glossary
slug: glossary
order: 29
eyebrow: Help
group: Help
---

# Glossary

The words Elowen uses across the CLI, the Web UI, and these docs, in plain language. Each entry links to the page that covers the topic in depth.

## Core concepts

| Term | Meaning |
| --- | --- |
| **brain** | The conversational agent you chat with — the part that reads your messages, reasons, decides which tools to call, and writes answers. See [Brain & Chat](brain-chat). |
| **model / executor** | The configured provider and model used by a conversation or delegated sub-agent. See [Agents & Providers](agents-providers). |
| **session** | One running instance of the brain, bound to a conversation and a set of permissions. The CLI, the web chat, and channels each hold their own sessions. See [Brain & Chat](brain-chat). |
| **conversation** | The durable message history a session works through. Conversations survive restarts and can be resumed from any surface. See [Brain & Chat](brain-chat). |
| **project** | A directory tree the agent is allowed to work in. Projects scope file access, shell commands, and search to known roots. See [Projects & Workflow](projects-workflow). |
| **channel** | A chat platform connected to Elowen — Discord, Telegram, Teams, or WhatsApp — where other people can talk to the agent. See [Channels](channels). |

## Automation

| Term | Meaning |
| --- | --- |
| **todo** | A lightweight checklist item attached to one conversation. Todos track the current request; they do not launch workers or grant authority. See [Todos, Goals & Workflows](tasks-missions). |
| **goal** | A durable outcome one conversation works toward across multiple turns, bounded by a turn budget and hard ceiling. See [Autonomy & Safety](autonomy-safety). |
| **workflow** | A directed graph of delegated sub-agents — independent nodes run in parallel, dependents wait for their inputs. See [Autonomy & Safety](autonomy-safety). |
| **sub-agent** | An isolated child conversation delegated one focused task. It receives a captured authorization boundary and can only narrow the caller's permissions. See [Agents & Providers](agents-providers). |
| **cron job** | A prompt Elowen runs on a recurring schedule — daily summaries, periodic checks. See [Scheduling](scheduling). |
| **wake-up** | A one-shot scheduled prompt that fires once at a set time or after a delay, then removes itself. See [Scheduling](scheduling). |

## Extending

| Term | Meaning |
| --- | --- |
| **plugin** | A bundle that adds capabilities to Elowen — tools, channels, scheduled jobs — loaded by the daemon. See [Plugins](plugins). |
| **skill** | A markdown instruction file that teaches the agent a repeatable procedure, loaded when a matching task appears. See [Skills](skills). |
| **tool** | A single callable action the agent can invoke — read a file, run a command, call an API — each with a declared input schema. See [Plugins](plugins). |
| **MCP** | The Model Context Protocol, an open standard for connecting external tool servers. Elowen can consume MCP servers and expose its own tools over MCP. See [MCP](mcp). |

## Memory and access

| Term | Meaning |
| --- | --- |
| **memory** | Durable facts Elowen stores about you and your projects between conversations — preferences, decisions, environment details — recalled when relevant. See [Memory](memory). |
| **embedding** | A numeric fingerprint of a piece of text that makes meaning-based search possible — over memories and over your code. See [Memory](memory). |
| **role policy** | The set of permissions attached to a role — what its holders may read, run, and approve. See [Users & Access](users-access). |
| **RBAC** | Role-based access control: permissions granted through roles assigned to accounts, rather than per-person rules. See [Users & Access](users-access). |
| **token scope** | The slice of access a single API token carries, so an automation or integration gets exactly the permissions it needs and no more. See [Users & Access](users-access). |

[Back to start](getting-started)
