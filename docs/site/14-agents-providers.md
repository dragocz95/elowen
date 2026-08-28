---
title: AI Providers, Models & Sub-agents
slug: agents-providers
order: 14
eyebrow: AI configuration
group: Automation
---

# AI Providers, Models & Sub-agents

Elowen's embedded brain is the agent behind Web UI chat, `elowen chat`, supported chat platforms, delegated sub-agents, and workflows. It runs through a configured AI provider and model; it is not the retired core coding-agent or mission subsystem.

## Connect an AI provider

The administrator manages providers in **Settings → Elowen AI**. The same setup is available during onboarding with:

```bash
elowen setup
```

The wizard can reuse an existing connection, connect an OAuth account, save an API-key provider, configure a custom OpenAI-compatible endpoint, or install and configure self-hosted Ollama. It finishes with a live chat smoke test when a model is available. Run `elowen doctor` later to check provider readiness.

### API-key providers

Elowen supports two provider protocols:

- **OpenAI-compatible** — the provider type used by OpenAI and compatible gateways. Presets include OpenAI, OpenRouter, Google Gemini, xAI (Grok), DeepSeek, Groq, Mistral, Together AI, Fireworks AI, Cerebras, Perplexity, Moonshot (Kimi), Z.AI (GLM), NVIDIA NIM, Hugging Face, Baseten, Ollama Cloud, and CoreSynth AI.
- **Anthropic Messages** — the provider type used by Anthropic (Claude).

To add one, open **Settings → Elowen AI → Providers → +** and set:

- a display label;
- the provider type;
- the API base URL;
- the API key;
- model IDs, one per line;
- optionally, the OpenAI wire API and temperature.

For an OpenAI-compatible entry, **Wire API → Auto** selects the Responses API for `https://api.openai.com`; other endpoints use Chat Completions unless you choose **Responses API** or **Chat Completions** explicitly. The temperature field accepts `0` through `2`; leaving it blank sends no temperature and lets the model use its own default.

OpenAI-compatible entries with an empty model list query `<base-url>/models`. A manual list is also allowed: it limits which models Elowen offers, while a successful `/models` response can enrich those entries with context-window information. If an endpoint has no `/models` route, enter the model IDs manually.

The built-in **Ollama (local)** setup uses the keyless endpoint:

```text
http://127.0.0.1:11434/v1
```

The setup wizard can install Ollama and download a selected model. A manually configured local Ollama installation must already be running on the Elowen host.

### OAuth accounts

The **Accounts** group in **Settings → Elowen AI** supports these sign-in types:

- **ChatGPT / Codex**
- **Claude**
- **GitHub Copilot**
- **Kimi**

Connect an account from its **Connect** button and finish the provider's browser or device-code flow. OAuth credentials are kept in Elowen's credential storage; they are not entered into the API-key provider form or returned to the browser.

After connecting, use **Pick models** on the account row to choose which catalog entries Elowen offers. An empty selection means the whole catalog. Disconnecting removes the usable credential; the saved model selection can be used again if the account is reconnected.

## Choose a model

A model is identified by its provider entry and model ID. The canonical runtime form is:

```text
<provider>/<model>
```

The provider and model are stored with the conversation, so a restart does not silently move it to another provider with a matching model name.

### Administrator model catalog

**Settings → Models** controls the instance-wide model catalog and context-window overrides. For a provider with an explicit model list, that list is the source of the models offered. For an OpenAI-compatible provider with no manual list, Elowen uses the endpoint's `/models` response. Connected OAuth accounts use their built-in catalog, narrowed only when the administrator selects a model list for that account.

The first configured provider is the server default. If no model is selected, Elowen uses that provider's first configured model; a bare OAuth account uses its current preferred catalog default when available. An empty custom OpenAI-compatible entry can populate the picker from `/models`, but it does not provide a runnable default until you select a concrete model. A provider named by an existing conversation must still exist—Elowen fails rather than silently switching the conversation to another provider.

For automatically discovered OpenRouter models, zero-cost IDs ending in `:free` are filtered out. A model that an administrator lists manually is retained, including a `:free` ID.

### Per-account model access

Set a user's default model in **Account → Elowen AI**. Administrators can use every model in the instance catalog. Other accounts see and can select only models allowed by the instance catalog and their personal model policy. A picker cannot grant access that the daemon has not allowed.

A conversation can switch models between turns:

- Web chat and **Account → Elowen AI** provide a model picker.
- In `elowen chat`, `/model` opens the picker.
- `/model <model>` switches directly when the model can be resolved.
- Inside the CLI `/model` picker, **Ctrl+P** opens API-key provider management.

The model choice does not change the conversation's Project, tools, plugins, memory identity, or permission boundary.

## Reasoning effort and fast mode

Reasoning controls are model-specific. In **Account → Elowen AI**, the thinking-level control shows only levels accepted by the selected model. A model without an adjustable ladder has no effort picker. The effective level is applied to the live conversation and persisted for the account.

Provider labels can differ from Elowen's canonical names. For example, the CLI displays Codex's canonical `xhigh` as **ultra**. Other models may expose `low`, `medium`, and `high`, while newer Claude and Codex models may also expose `xhigh` or `max`.

In the CLI:

```text
/reasoning              # open the current model's effort picker
/reasoning high         # set an accepted level directly
/reasoning show         # show or hide Thought rows in the transcript
```

`/fast` sets one durable preference for the account:

```text
/fast
/fast on
/fast off
/fast status
```

The preference remains enabled across unsupported models. Elowen sends a Fast wire option only when the actual request route and model explicitly support it (OpenAI/Codex/Azure priority service tier or Anthropic Fast mode).

## Vision and compaction models

These are per-account settings in **Account → Elowen AI**:

- **Vision model** is a fallback for image turns. Elowen uses it only when the current model is known not to accept images. A current model known to support images is kept.
- **Compaction model** can be different from the chat model and may use another configured provider. It is used for summarizing older conversation history, not for normal replies.
- **Auto-compact** is enabled by default at **80%** of the effective context window. The threshold can be set from **30% to 95%**, with per-model overrides.

A model's context window comes from provider metadata when available, or from an administrator override in **Settings → Models**. The override key is the provider/model pair, so two providers serving the same model ID can have different values.

## OAuth usage limits

Elowen reports subscription usage for connected **ChatGPT/Codex**, **Claude**, and **Kimi** accounts. GitHub Copilot does not currently have a subscription-usage rail in Elowen.

The account rows in **Settings → Elowen AI** show the usage windows returned by the provider. Readings are normally cached for 60 seconds and provider requests time out after 5 seconds. If a transient refresh fails, Elowen keeps the last reading and marks it stale. These are provider limits: Elowen cannot increase, reset, or predict them.

## Models in delegated work

`Delegate` creates a fresh child conversation for one focused task. It uses the caller's model by default, or another enabled model when the caller is allowed to use it. A child receives the caller's execution boundary and can only narrow it; selecting a stronger model does not grant more Projects, tools, or permissions.

A workflow is a directed graph of delegated children. Each node can select its own enabled model, so a graph can use a cheaper model for routine steps and a different model for steps that need deeper reasoning. Independent nodes may run in parallel; dependent nodes wait for their prerequisites. Built-in `explore` and `plan` sub-agent types are read-only. See [Autonomy & Safety](autonomy-safety) for permission and recovery rules.

## Troubleshooting provider setup

1. Run `elowen doctor` and read the Chat/provider check.
2. In **Settings → Elowen AI**, confirm the account is connected or the API-key provider shows a configured key.
3. For an OpenAI-compatible provider, verify the base URL and whether `<base-url>/models` responds. If it does not, enter model IDs manually.
4. Confirm the selected model is still present in **Settings → Models** and allowed for the account.
5. Run the provider's test from the setup flow or reconnect the OAuth account if its credential has expired.

Provider credentials stay on the daemon. Chat platforms receive the model's response, not the stored API key or OAuth token.

[Next: Autonomy & Safety](autonomy-safety)
