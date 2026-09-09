---
title: Usage Statistics
slug: stats-plugin
order: 46
eyebrow: Plugin reference
group: Plugin reference
---

# Usage Statistics

The registry plugin `stats`, version 0.2.4, adds a Web UI page for model usage analytics: token volume, tracked cost, cache efficiency, and generation speed. It is a browser view over Elowen's shared usage ledger and registers no tools, no controls, and no settings of its own.

## Where it appears

After the plugin is installed and enabled, a **Statistics** entry appears in the main navigation of the Web UI and opens the page at `/p/stats`. The plugin has no surface beyond that page and the usual card under **Settings → Plugins**. It adds no account panel and no slash command.

## What the page shows

The page covers a selectable date range and shows:

- four headline figures: total tokens, tracked cost, cache tokens, and average generation speed,
- a model search and a usage filter (all usage, usage with cost, usage served from cache); the search narrows the model list and reports how many models match,
- pie charts for tokens by model and cost by model; models without cost data are excluded from the cost chart,
- a daily usage trend of tokens and tracked cost, available only for the latest 90 days,
- a model breakdown table, paginated at 20 rows per page by default; selecting a model opens its detail with input tokens, output tokens, cache read, cache write, cache hit rate, and where the cost figure came from (calculated, provider reported, or unavailable).

The page introduces itself as a view of model consumption and reports when usage has synchronized. A model with no usage in the range shows an empty state rather than zeroed rows, and the selected date range is remembered for the next visit.

## Consumption origin

Administrators additionally get a **Consumption origin** view: a ranking of token use and cost by user, by address, or by user and address pair, alongside buckets for scheduled and internal runs, local access, and chat channels. An address counts as verified only when the request passed through the configured reverse proxy; anything else is a claim made by the client itself, and the page says so rather than presenting it as fact. Turn **Trusted proxy** off in the runtime settings if the instance is not behind such a proxy. Addresses removed by retention are shown as removed, not invented. Tokens and cost are two different rankings, and an address identifies a connection, not a person.

## Who can see it

Every authenticated account sees the Statistics entry and reads its own usage: the model breakdown and the daily trend cover the signed-in account's sessions. The origin view and the reset are administrator-only on the server, because origins carry addresses that span every account on the instance. The origin totals are a separate counter from the model and trend views: they start at the day origin tracking began, so the two are not expected to agree, and the page does not claim that they do.

**Reset usage** is a permanent action behind a typed confirmation (RESET). It clears the acting account's recorded usage snapshots and origin counters. Conversations and session transcripts remain available.

## Tools and configuration

The plugin has none. Its manifest provides no tools and no controls, and it declares no configuration fields and no per-account settings. There is nothing to configure: install it, enable it, and the page appears. Chat sessions notice no difference, because no tool is added to the model.

## Install and enable

1. Install `stats` from **Settings → Plugins → Available**.
2. It requires Elowen 0.28.21 or newer; the marketplace refuses installation on an older core.
3. Enable it. No per-user grant applies, because the plugin is not user-grantable.

The page needs no credentials and no restart. Related reading: [Usage & Costs](usage-costs) covers the in-chat usage views that work without this plugin.

## Permissions and consent

The manifest declares no capabilities and no mutating power, so enabling asks for no consent confirmation. The plugin is not user-grantable, and it contributes no tools for account permissions to narrow: access control happens on the usage routes the page reads, which serve every signed-in account its own usage and reserve the origin view and the reset for administrators.

## Known limits

- The daily trend reaches 90 days back at most; an older range shows no trend data.
- Models without cost data are left out of the cost chart, so its shares cover tracked spend only.
- Origin tracking starts on the day it was enabled; consumption before that date has no recorded origin.
- A reset is permanent for recorded usage and cannot restore or reconstruct anything.

[Next: Task List](todo-plugin)