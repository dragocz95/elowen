---
title: Agents & Providers
slug: agents-providers
order: 14
eyebrow: Automation
group: Automation
---

# Agents & Providers

Elowen's primary agent is the embedded brain used by chat, goals, delegated sub-agents, workflows, and account-owned automation. The retired core coding-agent/task subsystem is not required for these paths.

## Brain providers

Configure providers under **Settings → Elowen AI**. Elowen supports OpenAI-compatible and Anthropic API-key entries plus supported OAuth accounts such as Claude, ChatGPT, GitHub Copilot, and Kimi.

A provider entry defines:

- a stable provider id and display label;
- protocol/type and optional base URL;
- models shown in pickers;
- optional model-specific settings such as temperature;
- an API key or OAuth connection, which is never returned to the browser.

The canonical runtime identity is `<provider>/<model>`. Conversation rows persist both values so a restart restores the exact route rather than guessing from a model name shared by several providers.

## Model selection

Each account can have a default chat model and a narrower allowed-model set. Administrators may use every configured model; non-admin users cannot select a model outside the instance catalogue and their personal ceiling.

A conversation can switch model between turns. Delegated sub-agents and workflow nodes may use another configured model where the caller's model policy permits it. The selected model never changes Project, tool, plugin, memory, or permission authority.

## Delegated sub-agents

A sub-agent is a fresh child conversation created for one focused task. Built-in types include exploration and planning; users may add typed sub-agent Markdown definitions with their own description and tool mode.

The child receives a captured execution boundary from its caller and can only narrow it. Read-only types cannot write even when the parent can. Child status, usage, transcript, and result remain linked to the parent and survive restarts.

## Provider credentials and plugins

A plugin may reuse a centrally configured AI provider only through the capability-gated `ctx.resolveProvider()` seam and only for provider ids authorized by its own config/capabilities. New integration credentials that are not AI-provider keys use the encrypted plugin secret vault instead of ordinary config.

## External coding tools

Terminal and file tools operate through plugin capabilities and current account policy. A separately installed product plugin may integrate an external coding CLI or repository service, but it owns that process, route, data, and lifecycle. Core does not auto-create coding-agent sessions, tasks, missions, worktrees, or pull requests.

[Next: Autonomy & Safety](autonomy-safety)
