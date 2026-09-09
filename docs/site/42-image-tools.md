---
title: Image Tools
slug: image-tools
order: 42
eyebrow: Plugin reference
group: Plugin reference
---

# Image Tools

Two registry plugins add image work to a conversation. `image-gen`, version 0.2.3, draws a new picture from a text description. `image-edit`, version 0.2.3, changes an existing picture, either a file the account may already read or a public image on the web. Both produce a PNG that the chat displays directly.

## Where they appear

Each plugin has its own card under **Settings → Plugins**. Neither adds a Web UI navigation entry, an account panel, or a slash command. Their whole surface is two tools the model receives:

| Plugin | Tool | What it does |
| --- | --- | --- |
| `image-gen` | `GenerateImage` | Creates a brand-new image from a text prompt and returns it as a picture rendered inline in the web chat; the CLI shows the image URL instead. |
| `image-edit` | `EditImage` | Transforms one existing PNG or JPEG file, or one public image URL, by describing the change in words, and returns the edited result as a new picture. The source is never overwritten. |

## The shared image provider

Both plugins render through a provider that an administrator adds under **Settings → Brain**, and each asks you to select that provider in its own settings. Two kinds qualify:

- an OpenAI-compatible endpoint with an API key, whose key and base URL are reused for image calls, or
- the connected ChatGPT account.

Until a usable provider is selected, the tools do not exist: the plugin enables without errors and the model is offered no image tool at all. The image request itself is made by Elowen with the provider's credentials, which stay with the host and are never handed to the plugin.

The provider selector lists only providers of the two supported kinds. The connected ChatGPT account needs no key of its own; its sign-in credential is held by Elowen and is used for the image request without ever reaching the plugin. An API-key provider is used with exactly the key and base URL already configured for chat, so image calls cost nothing extra to set up. Each plugin resolves its own provider independently, so the two can render through different providers or share one.

## Generating images

`GenerateImage` takes a prompt and an optional size and produces one PNG per call. The picture is saved in the plugin's data area and returned as a markdown image, so the web chat renders it inline; the CLI shows the URL instead. The tool returns neither the raw bytes nor a file path.

Write the prompt as a concrete description of subject, style, composition, and colours: a vague prompt gives a vague picture. The tool is meant for pictures that do not exist yet, such as a logo, an illustration, a diagram, or a poster-like render. The size sets the aspect ratio: 1024x1024 square, 1536x1024 landscape, or 1024x1536 portrait. Any other value falls back to the configured default, and so does leaving the size out entirely.

The tool takes no source image, so it cannot change a picture that already exists; use `EditImage` for that. Text inside a generated picture is not reliable.

## Editing images

`EditImage` needs exactly one source, given either as a path to a PNG or JPEG file inside the repositories the account may access, or as a public http(s) URL that returns a PNG or JPEG image. Giving neither, or both, is refused. The `instruction` describes the change in words: remove or add an object, change the background or the colours, restyle the picture, or clean it up.

The result is a new PNG in the plugin's data area, shown in the chat like a generated one. The source file is never overwritten, and an edit is a fresh render rather than a pixel-exact patch of the original. The tool accepts the same three sizes as generation plus `auto`, which leaves the choice to the model.

A repository source must be a file ending in `.png`, `.jpg`, or `.jpeg`, and the plugin refuses to read a path outside the repositories the account may access. A URL source must respond with an image content type, `image/png` or `image/jpeg`; anything else is refused before the edit is attempted.

## How long a call takes

Image models are slow. A generation or an edit can take up to two minutes and then fail with a timeout, and fetching a public source URL for an edit is capped at the same two minutes. Expect a pause of that length whenever an image tool runs.

Each call produces its own new picture. Running the same prompt twice gives two separate files, and nothing in an earlier picture is updated or replaced by a later call.

## Install, enable, and grant

1. Install `image-gen` and `image-edit` from **Settings → Plugins → Available**. Each is installed and enabled in one step when no approval is pending.
2. Both plugins require Elowen 0.28.36 or newer; the marketplace refuses installation on an older core.
3. Open each plugin's detail view and select the image provider. The plugin warns in its activity log when it is enabled without one.
4. No per-user grant applies. Neither plugin is user-grantable, so every authenticated account can use the tools once a provider is configured.

Disabling a plugin or removing its provider takes the tools away on the next reload; work already running is not rewritten.

## Configuration

`image-gen`:

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Provider | `provider` | provider | not set | Which configured provider renders the images: an OpenAI-compatible endpoint or the connected ChatGPT account. Required. |
| Model | `model` | string | not set | Image model id. ChatGPT account: gpt-image-2.5-sunburst, gpt-image-2.5-flare, gpt-image-2, or gpt-image-1.5. API-key provider: whichever model its Images API serves, for example gpt-image-1. Empty uses the default for the chosen provider. |
| Size | `size` | enum | 1024x1024 | Output resolution and aspect ratio. |

`image-edit`:

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Provider | `provider` | provider | not set | Which configured provider renders the edits. Required. |
| Model | `model` | string | not set | Image model id, accepting the same values as for `image-gen`. |

The model field's placeholder in both plugins is `gpt-image-2.5-sunburst`, which is also the default the connected ChatGPT account uses when the field is left empty; an API-key provider falls back to `gpt-image-1`. Settings are saved by the plugin settings form, and a daemon restart is not required.

## Permissions and consent

Enabling either plugin asks for no consent confirmation, because neither declares a mutating capability. The `image-edit` manifest declares outbound network access, which the tool uses to fetch public source URLs itself. `image-gen` declares no capabilities of its own; its provider call runs through the host. Both tools remain subject to the account's tool permissions; see [Users & Access](users-access).

## Known limits

- A call may take up to two minutes and then fail with a timeout.
- One PNG is produced per call, and neither tool returns raw bytes or a file path.
- Text inside a generated image is not reliable.
- An edit is a fresh render, not a pixel-exact patch of the source.
- An edit source must be a PNG or JPEG, either as an accessible file path or as a public URL that returns that content type.
- Sizes outside the three supported values fall back to the configured default for generation, and to the model's own choice for an edit.
- A prompt or instruction is required; a call without one is refused before any provider request is made.
- Neither plugin contributes API routes, scheduled automation, or Web UI pages; the tools are the whole contribution.

[Next: OneDrive](onedrive-plugin)