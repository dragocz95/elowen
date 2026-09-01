---
title: Channels
slug: channels
order: 18
eyebrow: Channels
group: Channels
---

# Channels

Channels let people use the same Elowen instance from Discord, Telegram, Microsoft Teams, or WhatsApp. Each channel is a plugin adapter: it receives platform events, hands admitted messages to the brain, and renders the result using the platform's native delivery features.

## Choose a channel

- **[Discord](channels-discord)** — a bot connected to a Discord server.
- **[Telegram](channels-telegram)** — a long-polling bot for direct chats and groups.
- **[Microsoft Teams](channels-teams)** — an Azure Bot webhook for personal chats, group chats, and team channels.
- **[WhatsApp](channels-whatsapp)** — a paired WhatsApp account for direct chats and groups.

Enable and configure channel plugins in **Settings → Plugins**. Each plugin page describes its connection settings and platform-specific controls.

## How channel orchestration works

The daemon owns one common pipeline for all adapters:

1. The adapter authenticates and normalizes a platform event into a `SessionSource`.
2. The orchestrator checks the adapter's access policy, resolves the sender identity, and derives the channel key `<platform>-<threadId-or-channelId>`. Adapters append a `#generation` suffix when `/new` starts a fresh conversation.
3. The channel service maps that key to a durable `brain-ch-*` session, applies the turn's prompt and permissions, and runs the brain.
4. The adapter receives the final reply (or `undefined` when the sender was not admitted) and delivers it. Optional progress events support live rendering such as edit-in-place messages.

Adapters connect at daemon startup. A failed adapter is isolated so it does not prevent other configured platforms from starting. Out-of-band controls such as `/stop`, `/stats`, and `/compact` target the same channel session as an ordinary message.

## Access and linked identities

A channel policy decides whether a platform sender is admitted and whether they may use operator controls. Policies use the platform's native identifiers, and the first matching policy wins. An unmapped sender is ignored, except that Teams personal-chat account linking can offer Microsoft sign-in onboarding when enabled.

A human sender must also be linked to an Elowen account before a brain turn can run. The link is resolved from authenticated platform identity data—not from message text—and can use platform-verified email where supported. The linked account supplies project access, tool grants, account settings, and (when enabled) personal memory. A platform role or sender policy is not an Elowen account and does not grant project or tool access by itself.

The `admin` flag on a channel policy controls shared-channel operations such as model/reasoning pickers, context binding, and supported platform administration. It does not make the sender the instance owner or turn a shared room into private owner chat.

## Direct and shared conversations

The adapter's `direct` flag is accepted only after the host verifies both the platform link and session ownership:

- **Direct** means a genuine 1:1 chat. A new direct session is anchored to its linked sender, can use that account's personal context, and can receive scheduled results addressed back to that chat.
- **Shared** means a group, server channel, or any conversation whose sole-participant status is not proven. Its durable session owner is only an anchor for lifecycle and bookkeeping; each turn uses the verified writer's account for that turn. An unlinked writer is refused.

Existing session ownership is not silently reassigned when another person writes. A private chat that was initially opened on the operator fallback may be adopted once by its verified sender; after that, ownership remains stable. `/context` moves one of the invoking sender's own Elowen conversations into the channel after the server checks ownership again.

## Structured message envelopes

Ordinary shared-room messages are serialized as a JSON envelope before they reach the model and SQLite. The envelope marks its content as `untrusted` and carries the platform, channel, sender attribution, and clean message text. Sender names remain data; they are not interpolated into trusted prompt instructions. Imported history is stored as separate role-preserving messages rather than being concatenated with the live request.

If a turn is interrupted during a restart, a versioned resume envelope records the exact prompt append and serialized turn text, along with the channel, identity, model, and delivery metadata. It never stores authority as something to replay: the sender-to-account link, current account policy, and current tool grant are re-verified at resume time. Invalid, unlinked, or relinked identities fail closed instead of falling back to the operator.

## Per-turn grants

Every human platform turn uses the linked account's current project policy and tool authority. The effective tool scope is the account's allow grant narrowed by account and turn-level denies. Room roles can affect admission and trusted-room prompt composition, but they do not contribute an account's project or tool grant. A missing or empty allow grant remains restricted; it is never interpreted as unrestricted access.

The writer identity and its contribution scope are resolved for each shared-room turn, so personal skills, memory, and owner-scoped tools cannot leak from the room opener to another participant. Direct chats use their verified account consistently. Scheduled and delegated work carry host-authenticated scope rather than inventing a human platform identity.

## Delivery, interruption, and rollover

The normal response is returned to the originating adapter. Proactive delivery uses a host-validated destination envelope when a specific platform is selected; the host routes it to that platform's notification sink. Legacy raw IDs remain accepted by the adapters where supported. Failures are isolated across platforms, and delivery is reported as successful only when a sink accepted it.

For an eligible interrupted human turn, the daemon persists the turn before the provider call. After restart, it resumes through the ordinary channel pipeline and then delivers the computed answer to the original destination. Delivery retries do not run the model again. Scheduled turns, unlinked turns, and image-bearing turns are not boot-resumable because their authority or prompt bytes cannot be reproduced safely.

A channel that has been idle past the configured threshold (30 minutes by default) is rolled over before the next new turn when it is not streaming and has no active delegated children. The old live session is disposed and its transcript is re-keyed under a unique archived `brain-ch-*` ID; the stable channel key is then opened as a fresh session. The archived conversation remains browsable, while the channel continues under the same platform destination. A recent explicit interaction prevents rollover, and a resumed turn disables rollover so it can finish in the original session.

## Commands shared by channels

The exact menu is generated by the running daemon, so unavailable commands are not shown. Common commands are:

| Command | Purpose |
|---------|---------|
| `/new` | Start a fresh channel conversation. |
| `/stop` | Stop the running turn. |
| `/stats` | Show the current model, context usage, and usage. |
| `/compact` | Summarize the conversation to free context. |
| `/fast` | Set the linked account Fast preference; use `on`, `off`, or `status` when the surface accepts an argument. |
| `/model` | Open the platform's model picker. |
| `/reasoning` | Open the reasoning-effort picker. |
| `/context` | Open a picker of the invoking sender's own conversations. |
| `/help` | Show commands available on that surface. |

`/display` is available on Discord, Telegram, and Microsoft Teams. `/voice` is available on Discord and Telegram only. WhatsApp has neither command.

Shared-channel pickers and controls are usually operator-gated because their settings affect everyone in a room. An `AskUserQuestion` is answered by its addressed sender, or by an operator where the surface permits it. Discord uses native select menus and buttons, Telegram uses inline keyboards, Teams uses Adaptive Cards, and WhatsApp uses numbered text replies.

## Common presentation settings

Discord, Telegram, and Teams expose these global plugin settings, with per-channel or per-chat overrides through `/display`:

- `toolActivity` — `off`, `status`, or `live`.
- `answerMode` — `final` or `live`.
- `toolOutput` — `hidden`, `summary`, or `tail`.
- `toolMessageMode` — `single` or `per_tool`.

All four platforms can show processing reactions, a runtime footer, and optional model reasoning. Their defaults and supported controls are documented on each platform page.

[Next: Discord](channels-discord)
