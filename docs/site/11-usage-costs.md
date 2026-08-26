---
title: Usage & Costs
slug: usage-costs
order: 11
eyebrow: Everyday use
group: Everyday use
---

# Usage & Costs

Every token Elowen spends is counted, and the same numbers are visible wherever you work — the terminal chat, the web chat, and the web Stats page all read from the same daemon-side accounting. This page shows where to look, how to read the subscription windows, and how to spend less.

## The /stats overlay

In the [CLI](cli) chat, type **`/stats`** to open the usage overlay. Press **← →** to switch between its two sections.

**Conversation** covers the session you are in right now:

| Row | Meaning |
| --- | --- |
| model | The model answering this conversation |
| context | How full the context window is, as a percentage and a token count against the window size |
| tokens | Total tokens spent in this conversation |
| in / out | The input/output split — input is what you and the tools send in, output is what the model writes |
| cache hit | Share of input read from the provider's prompt cache instead of being billed at full price |
| cost | Estimated dollar cost of this conversation so far |
| speed | Generation speed in output tokens per second |

**Models** aggregates everything the daemon has recorded, one row per model and runtime: total tokens, cached tokens, measured speed, and cost, sorted by usage, with a totals row at the bottom. This is the "where did my tokens go" view — it includes background work such as sub-agents, workflows, and scheduled jobs, not just your interactive chats.

The web chat opens the same data as a modal from the chat header. For a standing overview, the web **Stats** page charts model usage over a selectable date range — total tokens, total cost, cache volume, models used, and average speed. An administrator can reset the stored counters there after typing a confirmation word; this only wipes the accounting snapshots, never any conversation or transcript.

> Costs are estimates computed from token counts and each provider's price list. Your provider's invoice is the authoritative number.

## The telemetry rail and the status bar

You do not have to open anything to keep an eye on spend. The CLI telemetry rail shows the current conversation's model, context fill, and usage while you chat, and the status bar can show context usage, total tokens, and cost permanently — pick which segments you want with **`/statusline`**. That choice is stored in the shared statusline config, so it also applies to the web chat dock.

## OAuth subscription windows

When you connect a ChatGPT, Claude, or Kimi account through OAuth instead of an API key, usage is not billed per token — it counts against your subscription's rate-limit windows. Elowen polls the provider's usage endpoint and shows those windows directly:

- In the **CLI telemetry rail**, keyed to the active model's provider — typically a 5-hour window plus one or more weekly windows, whatever the provider reports.
- In the web UI under **Settings → Elowen AI**, as a slim meter on each connected OAuth account row, one meter per window. The fill turns warning-colored at 70 % and danger-colored at 90 %; hovering shows when the window resets.

Readings are cached for about a minute so the rail does not hammer the provider. If a refresh fails — a network hiccup, a provider timeout — Elowen keeps showing the last good snapshot and marks it as a **cached reading** so you know the numbers are slightly old rather than live. A stale reading clears itself on the next successful poll.

> These windows are the provider's own limits. Elowen only reports them; it cannot raise, reset, or predict them beyond the reset time the provider returns.

## Reading the numbers

A few patterns make the views easier to interpret:

- **High input, low output** is normal for agent work. Reading files, search results, and tool output all count as input; the model's replies are usually the smaller half.
- **Cache hit rate** tells you how much of that input the provider served from its prompt cache. A healthy long conversation often sits well above 50 %, because the stable prefix — system prompt, project context, earlier turns — is cached and only the new tail is billed fresh.
- **Context percentage** is the one to watch mid-task. As it climbs toward the window size, older history needs compacting (see below), and very full contexts also make every turn slower and more expensive.

## The prompt cache

Providers serve most input from a prompt cache rather than re-processing the whole context on every request. A long conversation is a natural fit: the system prompt, project context, and earlier turns are byte-identical on every call, so reading them from the cache is both cheaper and faster than rewriting them from scratch. The cache only pays off while those bytes stay unchanged — anything that rewrites the middle of the context, such as re-attaching the same large file or churning files the agent re-reads every turn, invalidates the cached prefix and the whole context is billed fresh again.

Elowen keeps the stable parts stable for exactly this reason. Recalled memories are injected at a fixed, anchored position in the context instead of appended wherever the work happens to be, so a mid-turn recall does not move the bytes the provider already cached. Historical images are likewise replaced by a short placeholder, because re-serializing an old image into every request would change those bytes every time. The **cache hit** row in `/stats`, and the cache volume on the web Stats page, show how well this is working.

## Cutting costs

**Use a cheaper model for routine work.** Not every job needs the frontier model. Switch the conversation model with **`/model`**, and give scheduled jobs and delegated sub-agents a smaller model when the task is mechanical — summaries, cleanups, watchers. Provider and model setup is covered in [Agents & Providers](agents-providers).

**Compact long conversations.** A conversation that runs for hours carries its whole history into every turn. **`/compact`** folds older history into a summary plus the useful tail, which drops both cost per turn and latency. See [Brain & Chat](brain-chat) for how compaction behaves.

**Keep the context cache-friendly.** The provider's prompt cache works best when the start of the context stays stable. Attaching the same large file repeatedly, or churning project files the agent re-reads every turn, defeats it. Attach once, let the agent work from there, and the cache hit row in `/stats` will show the difference.

**Prefer subscriptions for heavy interactive use.** If you have a ChatGPT, Claude, or Kimi subscription, connecting it via OAuth moves interactive chat off per-token billing entirely — you are bounded by the rate-limit windows instead, which the rail shows you live.

**Watch model usage after automation.** Workflows and scheduled jobs can run while you are away. The per-model totals in `/stats` show when an automation is chattier than intended; [Scheduling](scheduling) explains how to bound recurring work.

[Next: Your Account & Preferences](account-preferences)
