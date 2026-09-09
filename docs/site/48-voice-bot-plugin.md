---
title: Voice Calls
slug: voice-bot-plugin
order: 48
eyebrow: Plugin reference
group: Plugin reference
---

# Voice Calls

The registry plugin `voice-bot`, version 0.1.1, places outbound telephone calls. The `VoiceCall` tool dials a real phone number and hands the conversation to a voice agent that follows the briefing sent with the call: the person's phone rings within seconds, the tool waits for the call to finish, and the result comes back with a transcript of what was said.

A call cannot be cancelled, recalled, or undone once it is placed. The tool's own instructions require the model to dial only a number the user gave in the conversation or read from a record the user pointed at, to quote the number back when in doubt, and never to retry an uncertain call automatically.

## Where it appears

The plugin has a card under **Settings → Plugins** and no other surface: no Web UI navigation entry, no account panel, and no slash command. It contributes one tool:

| Tool | What it does |
| --- | --- |
| `VoiceCall` | Places a real outbound call, blocks until the call has ended, and returns whether it was answered, how long it lasted, the service's verdict, and the transcript. |

## What the call service must provide

The plugin is a client for your own voice service, configured with two required fields:

- **Call endpoint** (`apiUrl`), the full https URL that every call request is sent to. Only http and https are accepted.
- **API token** (`apiToken`), sent as an `Authorization: Bearer` header.

Without both, no call tool is offered to the agent at all: the plugin enables without errors and nothing appears. The service holds the request open for the whole conversation and answers once, after the call, with whether anybody picked up, how long it lasted, a status, and the transcript. A remote call id, when the service returns one, is kept with the call record.

## The per-user grant

The plugin is user-grantable. Non-admin accounts cannot use `VoiceCall` until an administrator grants the plugin to them under **Users → Granted plugins**; administrators always retain access. See [Users & Access](users-access) for the grant flow.

## Placing a call

The phone number must be in full international E.164 form: a leading `+`, the country code, then the national number in digits only, 8 to 15 digits in total, with no spaces or dashes, for example `+420123456789`. Anything else is refused before a call is attempted.

The `prompt` is spoken instructions for the voice agent, written in the language the person being called speaks, up to 4,000 characters. It describes what the agent should find out or convey and how it should behave; it is not a message read aloud. An optional opening sentence is spoken first when the call is answered, falling back to the configured default.

## Rate limit and timeouts

| Limit | Value |
| --- | --- |
| Calls per rolling hour | 10 by default, configurable between 1 and 200 |
| Longest single call | 300 seconds by default, configurable between 60 and 1800 |

The hourly limit counts calls started in any 60-minute window. Failed calls count too, because a service that rejects every request must not invite endless retries, and the window survives a restart. When the limit is reached, the tool refuses and reports roughly when it frees up; no call is made.

The call length setting is not a connection timeout: the service holds the request open, so the setting bounds the conversation itself. Set too low, it reports a call that went perfectly well as having an unknown outcome, so keep the default unless a specific conversation needs longer. When the plugin itself gives up, the outcome is reported as unknown and the call must not be retried automatically: ask the person whether the phone rang before dialling again.

## Install, enable, and grant

1. Install `voice-bot` from **Settings → Plugins → Available**.
2. The manifest declares no minimum core version.
3. Enter the call endpoint and the API token in the plugin detail view. The tool appears only once both are set.
4. Grant the plugin to the accounts that may place calls.

## Configuration

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Connection | `sec_connection` | section | not set | Heading that groups the connection fields; saves no value. |
| Call endpoint | `apiUrl` | string | not set | Full URL each call request is sent to. Required. |
| API token | `apiToken` | secret | not set | Bearer token for the call service. Required. |
| Limits | `sec_limits` | section | not set | Heading that groups the limit fields; saves no value. |
| Maximum calls per hour | `maxCallsPerHour` | number | 10 | Calls started in any 60-minute window, between 1 and 200. Flagged as a high-risk setting. |
| Longest call | `callTimeoutSeconds` | number | 300 | How long a single call may run, between 60 and 1800 seconds. |
| Default opening sentence | `defaultInitMessage` | string | not set | Spoken first whenever a call carries no opening sentence of its own. Leave empty to let the voice service open the call. |

The token is a secret field: Elowen stores it in its encrypted secret store and shows only whether it is set. It is never written to a log line and never returned to the agent, not even in an error, and it is removed from the service's own response text before that text is shown.

## Permissions and consent

The manifest declares database read access and outbound network access and no mutating capability, so enabling asks for no consent confirmation. The grant described above gates the tool; account tool permissions can narrow it further.

## Call records

Every call the plugin starts is recorded before the request leaves, whether or not the service answers: who asked for it, in which conversation, the number dialled, the briefing, and, for a completed call, what was said. The transcript is the evidence of what was spoken on the account's behalf, so a completed call keeps it, capped at 8,000 characters per record. Deleting an account removes its call records.

## Known limits

- There is no allow-list of callable numbers and no per-call confirmation step; the hourly limit is the only brake on the tool.
- A placed call cannot be undone, and the person called has no way of knowing it was a mistake except by answering it.
- A timeout leaves the outcome unknown; never retry such a call automatically.
- The tool blocks for the whole call, normally tens of seconds, and there is nothing to poll afterwards.
- A call record keeps at most 8,000 characters of the service response, which carries the transcript.

[Back to start](getting-started)