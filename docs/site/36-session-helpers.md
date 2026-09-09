---
title: Session Helpers
slug: session-helpers
order: 36
eyebrow: Plugin reference
group: Plugin reference
---

# Session Helpers

Five small bundled plugins shape the details of a session instead of adding a capability of their own. They are grouped here because each one is small, ships with every installation, and is enabled in a fresh install. None of them requires a per-user grant, and enabling any of them never asks for a consent confirmation, because none declares a mutating capability. Only the status line has a command of its own: the CLI offers **`/statusline`** while that plugin is enabled. Administrators manage all five under **Settings → Plugins**. Disabling one of them removes only its contribution and leaves the other four untouched.

For the plugin manager, grants, and general plugin behavior, see [Plugins](plugins).

| Plugin | Version | Adds |
| --- | --- | --- |
| `askuser` | 0.2.1 | The AskUserQuestion tool |
| `elowen-docs` | 0.1.0 | The DocsSearch tool over this manual |
| `changelog` | 0.1.0 | The What's new page with release notes |
| `runtime-context` | 0.2.0 | Date, time, sender, and chat type on every turn |
| `statusline` | 0.1.1 | A configurable status line under the conversation |

## AskUserQuestion

The `askuser` plugin adds one tool, `AskUserQuestion`. It pauses the turn and asks you one or more structured questions, then hands your answers back to the model. Interactive surfaces show clickable controls: the Web UI shows a card and the CLI shows a docked picker, while text-only surfaces may request a numbered answer.

| Property | Value |
| --- | --- |
| Questions per call | 1 to 4 |
| Options per question | 2 to 4, each with a label and a description |
| Multiple selection | Optional per question |
| Free-text answer | Enabled by default; the model can turn it off for one question when free text would be an invalid answer |
| Recommended option | Placed first and labeled as recommended |
| Answer format | One short answer line per question, plus the preview of any chosen option |

Each question carries a short header shown as a chip. A chip longer than the render budget of about 12 characters is clipped where it is drawn, never rejected. An option can carry a preview, rendered as Markdown in a monospace box, which the model can use for comparing mockups, code snippets, or configuration examples side by side. Previews are available for single-select questions only, and are dropped when multiple selection is on. When any option carries a preview, the card switches to a side-by-side layout with the option list on the left and the preview on the right; without previews, the question renders as a simple list.

The tool's usage guidance tells the model to reach for it when gathering preferences, resolving an ambiguous instruction, or choosing between approaches as work proceeds. An always-present free-text choice stands in for a written "Other" option. While a plan is being prepared, the model is told to use the tool to settle requirements before finishing the plan, and never to ask for plan approval with it.

The plugin also adds a short standing instruction telling the model to prefer this tool when a decision is genuinely yours to make, and to ask before it proceeds on an assumption.

The plugin has no configurable fields.

Limits: question texts must be unique within one call and option labels unique within a question. The turn waits until you answer, so a question asked by accident holds the work until it is answered.

## Docs search

The `elowen-docs` plugin adds one tool, `DocsSearch`. It searches the shipped product manual and returns the closest sections, each labeled with the page and the heading it came from. The model uses it to answer what the product can do, where a feature lives, and what a setting means, and to check a setting before changing it. It searches product documentation only; for your own repositories there is the separate codebase plugin.

Ranking is semantic when an embedding model is configured under **Settings → Memory**, see [Memory & Embeddings](memory). Without one, the tool falls back to keyword ranking over literal word overlap, with headings weighing more than prose, and every result states explicitly which mode ran. A fresh installation without an embedding model therefore gets keyword matches rather than an error.

The corpus is the numbered manual pages that ship with the installation. It is fixed and read-only, and it changes only when Elowen is upgraded. The tool indexes one section per heading, splitting a section longer than 1,500 characters at a paragraph break. The index is built on first use into the plugin's own storage and rebuilt when the manual or the embedding model changes; the rebuild covers a few hundred sections and takes seconds. Because the corpus is the manual that ships here, the results always track the installed version: the first search after an upgrade rebuilds the index against the new pages.

A query returns up to k sections, 6 by default and 20 at most. Each result names its page, its heading path, and its text, with the match score alongside. There is no minimum-score cutoff: results are ranked, capped, and published with their score so the reader can weigh them. Scores are relative to the query and not comparable across queries.

Each result carries the text of its section, indented under the page and heading label, so the answer is readable without opening the manual.

The plugin has no configurable fields. Its manifest declares read access to the shared embedding pipeline and the outbound-network capability, and enabling it asks for no consent.

## What's new

The `changelog` plugin requires Elowen 0.28.33 or later. It publishes the release notes that shipped with the installed Elowen version on a **What's new** page in the Web UI. The notes travel inside the plugin as Markdown entries, one per release, so an upgraded instance shows the new notes without anyone writing them into it. Entries are shown newest first, with pinned entries ahead of the rest.

The navigation entry sits in the infrastructure group and wears a badge with the number of releases your account has not read yet. A pair of counters at the top of the page shows the total number of releases and the number still unread. The unread marker is per account: opening the page marks every shipped release as read and clears the badge. Releases newer than your last visit carry a New marker under the heading New since your last visit. The marker only moves forward, so downgrading Elowen does not bring old badges back. On an instance in open mode, which has no accounts, unread tracking is switched off and no badge is shown.

| Entry field | Meaning |
| --- | --- |
| Version | The release version; it identifies the entry |
| Date | When the release shipped |
| Title | Shown in the list and on the entry |
| Tags | Free-form labels for the release |
| Pinned | Holds the entry above the rest of the list |

Entries are written in English and may ship Czech and Slovak translations; the page uses the interface locale and falls back to English. Note images are limited to common raster formats and are served with immutable caching; SVG is deliberately not served.

The plugin adds no tools and has no configurable fields. Its manifest declares read access to the shared database, which holds only the per-account seen marker, and three user-scoped API routes backing the page:

- `entries` returns the listing metadata, or one full entry looked up by version.
- `seen` records the newest release just shown and returns the stored marker.
- `asset` serves a note image by release version and file name.

Limits: the notes are read-only. An operator cannot add or edit them from the instance; new notes arrive with upgrades.

## Runtime context

The `runtime-context` plugin adds two short context blocks to every turn. The first states the current weekday, date, time, timezone, and part of day. The second states who the model is speaking with and what kind of conversation it is. The blocks are injected as per-turn context rather than a system prompt change, so the cached prompt prefix stays stable.

The part of day follows the same timezone, moving through early morning, morning, midday, afternoon, and evening to night.

The context is not visible anywhere in the interface. The plugin adds no tools and no navigation entry; its configuration lives in the plugin detail view. The conversation kind is stated explicitly because the model cannot otherwise tell a private chat from a shared room, and anything it creates on your behalf should be filed accordingly.

| Conversation kind | What it tells the model |
| --- | --- |
| Own chat | The sender's own Elowen chat |
| Direct chat | A direct 1:1 chat that nobody else can read |
| Shared room | A room other people can read, so the sender changes from message to message |
| Delegated run | A run with no conversation of its own |

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Timezone | `timezone` | timezone | not set | IANA timezone for the whole assistant, for example Europe/Prague. Empty uses the server's own timezone. |

The timezone sets two clocks at once: the date and time injected into every turn, and the clock that every scheduled job runs on, so a job scheduled for 07:30 fires at 07:30 in this zone. The value is read per turn, so a change applies from the next turn. See [Scheduling](scheduling).

Limits: the timezone is instance-wide and applies to every account and channel. The sender line comes from the platform identity: a linked Elowen account appears under its display name, and a sender without an account is stated as unverified. Display names are stripped of line-breaking characters and capped at 80 characters, so a crafted name cannot forge extra lines into the context block.

## Status line

The `statusline` plugin shows a live status line below the conversation in the Web UI and in the `elowen chat` CLI. Each piece of information is a separate toggle, and all of them are off by default, so the line is empty in a fresh install.

The plugin adds no tools and no navigation entry. The daemon exposes the display toggles and the chat clients render the line; the toggles are configured in the plugin detail view, and the CLI command **`/statusline`** opens a picker for the same choices.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Model | `showModel` | boolean | false | Show the active model name. |
| Context usage | `showContext` | boolean | false | Show how full the context window is, in percent and tokens. |
| Total tokens | `showTokens` | boolean | false | Show the conversation's cumulative token count. |
| Speed | `showSpeed` | boolean | false | Show measured output speed in tokens per second. |
| Cost | `showCost` | boolean | false | Show the conversation's cumulative cost. API-key providers report it; subscriptions show $0. |

The setting is instance-wide, so the line shows the same pieces for everyone. The plugin changes no prompt and stores nothing about the conversation. Changes to the toggles apply without a daemon restart.

Limits: with every toggle off nothing is displayed. Cost appears only as reported by the provider: API-key providers report a cumulative cost, while subscription-based access shows $0.

[Next: Chat Platform Plugins](chat-platform-plugins)