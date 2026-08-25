# elowen-plugin-shared

Runtime helpers shared by [Elowen](https://github.com/dragocz95/elowen) chat-platform plugins — the parts
of a Discord/Telegram/Teams/WhatsApp adapter that are the same on every surface: message formatting and
chunking, the live-message engine, chat commands, role-based access, display settings, voice
transcription, image handling and atomic JSON state.

It ships with the daemon, so an installed plugin resolves it through the `node_modules` symlink the
plugin installer creates. A plugin therefore runs against the version its HOST daemon carries, not the
one it was developed against.

## Usage

Each helper is its own entry point — importing one does not pull the rest in:

```js
import { stripThinking, splitForLimit } from 'elowen-plugin-shared/format';
import { LiveMessage } from 'elowen-plugin-shared/liveMessage';
import { readJsonSafe, writeJsonAtomic } from 'elowen-plugin-shared/atomicJson';
```

The package root exports only the contract version:

```js
import { PLUGIN_SHARED_API_VERSION } from 'elowen-plugin-shared';
```

`PLUGIN_SHARED_API_VERSION` is bumped when an existing export changes shape or disappears — not when
something is added.

A plugin does not check it in code. Declare the major you build against in `elowen-plugin.json`:

```json
{ "requiresSharedApi": 2 }
```

The daemon refuses to install or load a plugin whose declared major differs from the one it ships, and
says which is which. That check has to happen before the plugin's entry module is imported: a removed
export fails at link time, inside `import()`, where no code of the plugin's own could report it.

## Modules

| Entry point | What it does |
| --- | --- |
| `/access` | Role-based access resolution (model, reasoning level, project scope) for a chat member. |
| `/atomicJson` | Crash-safe JSON read/write (write to a temp file, then rename). |
| `/chatCommands` | The control commands every adapter shares (`/model`, `/reasoning`, `/display`, …). |
| `/display` | Per-conversation display settings merged over the plugin config. |
| `/format` | Message formatting: reasoning stripping, fenced-block-aware splitting, runtime footers. |
| `/help` | The shared `/help` text. |
| `/httpClient` | HTTP client with concurrency limits, idempotent retries and structured errors. |
| `/images` | Resolving and typing image attachments in both directions. |
| `/lifecycle` | Localized daemon lifecycle notices (stopping, back online, restart). |
| `/liveMessage` | The live-message engine: one message edited as a turn streams. |
| `/liveTrace` | Tool-call trace rendering and folding for a live message. |
| `/messages` | Surface-neutral user-facing strings. |
| `/stateStore` | Per-conversation state persisted as JSON. |
| `/turnResult` | Turn outcome rendering, including error shapes. |
| `/voice` | Voice-note transcription. |

## License

MIT
