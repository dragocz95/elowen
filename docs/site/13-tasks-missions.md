---
title: Todos, Goals & Workflows
slug: tasks-missions
order: 13
eyebrow: Automation
group: Automation
---

# Todos, Goals & Workflows

Elowen no longer ships the former core Tasks, Missions, Autopilot, coding-agent session, or pull-request workflow. Those route families and settings are not part of core Projects.

Current long-running work uses three independent mechanisms:

## Conversation todos

The bundled todo plugin keeps a lightweight checklist attached to one conversation. Todos have a subject, description, status, and optional dependencies. They help the assistant and user track the current request; they do not launch workers, own Git state, or grant authority.

Use `/tasks` in chat to inspect and update the conversation's checklist.

## Persistent goals

`/goal <outcome>` lets the current conversation continue toward a durable outcome across turns, with subgoals, a configurable turn budget, and a hard safety ceiling. The goal always uses the conversation's current account, Project, permission, and plugin boundaries.

Useful commands include `/goal draft`, `/goal status`, `/goal pause`, `/goal resume`, `/goal clear`, and `/subgoal <text>`.

## Delegation and workflow DAGs

`Delegate` starts a focused child conversation under a captured authorization boundary. A workflow decomposes one request into a directed graph of those children: independent nodes may run in parallel, while dependent nodes wait for prior results. Each node can use an appropriate model without sharing mutable context with siblings.

Delegated children cannot widen the caller's access. Their status, tool activity, transcript, and result remain attached to the parent conversation and survive daemon restarts.

## Optional domain plugins

A separately installed plugin may add its own task tracker, repository integration, or other product vertical. Such a plugin owns its tables, routes, tools, pages, configuration, and lifecycle. Disabling it must not change generic Project registration, conversation todos, persistent goals, or sub-agent workflows.

[Next: Agents & Providers](agents-providers)
