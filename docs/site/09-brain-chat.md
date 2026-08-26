---
title: Brain & Chat
slug: brain-chat
order: 9
eyebrow: Everyday use
group: Everyday use
---

# Brain & Chat

The brain is Elowen's embedded, in-process agent runtime. It is what you talk to in the terminal, Web UI, and supported chat platforms. Tasks may use a separate coding CLI in tmux, but a brain conversation is a server-side agent session with its own history, tools, policy, model choice, and live event stream.

![Elowen brain chat](images/brain-chat.png)

## One conversation model across surfaces

The Web UI chat dock, terminal chat, Discord, Telegram, Microsoft Teams, and WhatsApp all call the same daemon service. They differ only in how they identify and present a conversation:

- **The Web UI** follows the user's active conversation and exposes chat alongside the current workspace.
- **The CLI** binds to a resolved session, so using a second terminal does not unexpectedly move another surface.
- **Platform adapters** maintain channel-scoped conversations and apply the mapped user's project, tool, model, and role policy.

Every conversation is checked against the authenticated user's access at the daemon. A UI control cannot grant a model, project, or tool that the server has not allowed.

## Turns that stay coherent

Only one turn runs in a conversation at a time. If you send a message while the agent is working, it is accepted into a durable queue and delivered as a follow-up after the current turn. Queued items are visible to connected clients and survive a daemon restart. Press **↑** (CLI) or use the recall control (web) while the queue is non-empty to edit or remove a queued message before it is delivered.

Long conversations are managed in three complementary ways:

- **Compaction** summarizes older history while retaining the useful tail. The compaction marker and summary are persisted, so the saved tokens are not lost on a later reload.
- **Image pruning** strips historical image attachments from the model context once they are no longer in the active window, curbing token bloat without losing the surrounding text.
- **Idle rollover** can start a fresh session after a configured idle period, when continuing an old prompt cache would be wasteful. The previous conversation stays available to browse.
- **Limits** bound agent steps, tool-output previews, memory recall, goal turns, elicitation waits, and channel-session capacity. Instance owners configure these in **Settings → Elowen AI**.

## Compaction

When a conversation grows long, Elowen summarizes the older history so the model's context window never overflows. You simply keep talking — the summary replaces the bulky early messages, and nothing that matters is lost. Long-term memory is a separate store and is unaffected by compaction.

### Automatic compaction

Compaction triggers automatically when the conversation reaches a threshold of the model's context window — 80% by default. You can tune the threshold anywhere between 30% and 95%, or turn automatic compaction off entirely, in **Account → Elowen AI** (the auto-compact toggle and slider). A between-turn check makes sure the next request never overflows the window mid-work. Channel conversations and unattended workers compact automatically too, so long-running automation needs no babysitting.

### Per-model thresholds

Different models have very different context windows, and a single threshold may not fit all of them. The per-model drawer in **Account → Elowen AI** lets you set a different threshold for each model — a small-context model compacts earlier, a large one later. Each row shows the model's context size so the choice is informed, and any override can be reset back to the default per model.

### Compaction model

Summarizing does not have to use the same model you chat with. You can pick a separate compaction model — for example, chat on Claude but have a cheaper model do the summarizing. By default the conversation's own model compacts itself.

### Manual compaction

Type `/compact` in the CLI to compact now, without waiting for the threshold. Type `/compact <text>` to steer the summary toward what you want it to keep. If there is nothing worth compacting yet, the command is a harmless no-op.

### What survives a compaction

Compaction is not a blind trim. What carries over:

- The recent tail of the conversation, kept verbatim.
- Your active plan, which is persisted to disk and re-injected after compaction.
- A working set of up to 12 files the agent has touched, marked as edited or read.
- Long-term memory, which lives outside the conversation entirely.

> After a compaction, the agent is instructed to re-read files rather than trust the summary — so always trust freshly re-read state over a recalled detail.

### What you see

The CLI shows a `compacting conversation…` note while it runs, then a `· · · context compacted · · ·` divider in the transcript. Web chat shows the same labelled divider. The compaction marker and summary are persisted, so the saved tokens are not lost on a later reload.

## Personality

The personality setting shapes the tone and verbosity of your agent's replies. Four presets are available: **professional**, **friendly**, **concise**, and **detailed**. In Czech conversations it also controls tykání versus vykání.

Set it in **Account → Elowen AI** — the presets appear as pills. Your choice applies to your conversations on every surface: CLI, web chat, and channels.

If none of the presets fits, you can write your own custom personality text, which overrides the preset entirely. See [Your Account & Preferences](account-preferences) for details.

## Models and reasoning

Elowen supports configured OpenAI-compatible and Anthropic providers, plus OAuth-backed **Claude**, **ChatGPT**, **GitHub Copilot**, and **Kimi** accounts. A provider's model catalog is used by chat, delegated sub-agents, and plugins that request a model field. OpenRouter's zero-cost `:free` catalog variants are filtered out at the source, so every listed model has metered, reported pricing.

Select a model for the current conversation where your surface provides a picker. Reasoning options are shown only when the chosen model exposes them. ChatGPT OAuth models can additionally use priority processing through `/fast` when the selected model supports it. The daemon preserves provider credentials and returns only safe configuration metadata to the Web UI.

Connected **ChatGPT**, **Claude**, and **Kimi** accounts expose their subscription usage limits, which Elowen polls and maps into shared 5-hour and weekly windows. In **Settings → Elowen AI**, each connected OAuth account row carries a slim per-account subscription usage bar. It is reported independently of the active model and colored by pressure: accent normally, warning at about 70%, then danger at about 90%.

Use the provider connection flow in **Settings → Elowen AI**. It can test a configured provider before you rely on it for normal chat or automation. In the same connected-accounts list, an unused, disconnected OAuth account type can be hidden and later restored from a **+** menu. This is a display filter only — credentials and provider entries are untouched, and a type that is actually connected is never hidden.

## Context is assembled per turn

Elowen builds a normal turn from the user's message plus the current policy, selected tools, relevant memory, skills, and plugin contributions. Dynamic context is sampled for the current turn only, so time-sensitive information does not become a stale system prompt or a stored user message.

Plugins may request their dynamic context before or after the user's text. Both placements are explicitly framed as ephemeral context, are not persisted in the transcript, and are skipped for raw plugin prompt commands. This lets a plugin add live facts such as the current date or runtime state while preserving the user's original message and conversation history.

## Memory

Memory is per user and durable. Before a turn, Elowen retrieves a small, relevant set of memories; semantic retrieval is used when an embedding model is configured, otherwise it falls back to keyword retrieval. Retrieved text is framed as context rather than executable instruction.

Recall does not stop at the start of a turn. The opening search is driven by your message alone, which says little once the work moves on to files, tools, and errors, so additional passes search again from what the turn has actually done. Mid-turn recall never blocks the answer: the search starts and the model proceeds, and any memory it finds lands in the context one model call later. Retrieved memories are injected at a fixed, anchored position rather than appended wherever the work happens to be, so their arrival does not move the bytes the provider's prompt cache already holds. Shared channel sessions do not run mid-turn recall, because one person's memories must never surface to another sender.

Both recall paths have their own switch in **Account → Memory**: auto-recall searches after each message, and the "recall while working" toggle covers the mid-turn passes. Operators bound how many mid-turn searches a single turn may run and how much context their results may add in **Settings → Elowen AI → Limits** (recall while working — passes, memories, and tokens).

After an owner exchange, optional curation can extract durable facts in a capped background operation. You can inspect, create, edit, categorize, merge, restore, or purge memories in the [Memory workspace](web-ui#memory).

![Memory workspace](images/brain-memory.png)

Configure embeddings and categorization in **Settings → Memory**. An API-key or OpenAI-compatible Elowen AI provider can be reused without storing a duplicate key. OAuth-only accounts do not expose an embedding endpoint, so semantic memory needs a supported embedding provider; without one, recall remains available through keyword matching.

## Tools, approvals, and output

Tools come from the core and enabled plugins. Per-user policy narrows the visible and executable tool set, and execution-time checks remain authoritative. A tool's successful output is hidden unless its built-in or plugin declaration explicitly opts into transcript display; failures and important annotations remain visible.

Approval questions are part of the conversation lifecycle. Interactive turns can wait for a decision; unattended work follows its captured non-interactive permission boundary and fails closed when it cannot obtain authority. See [Autonomy & Safety](autonomy-safety).

[Next: Memory & Embeddings](memory)
