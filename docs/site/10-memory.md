---
title: Memory & Embeddings
slug: memory
order: 10
eyebrow: Everyday use
group: Everyday use
---

# Memory & Embeddings

Elowen memory stores durable, reusable facts across conversations: preferences, decisions, project details, and environment topology. It is not a transcript or a chat archive.

Memory is private to one Elowen account. A conversation can recall only that account's memories, and unlinked platform senders and delegated task workers cannot use the memory tools.

## How recall works

Elowen can recall memories automatically at the start of a turn and, when enabled, again while work is in progress.

- With embeddings configured, retrieval is semantic: it matches meaning rather than exact words.
- Without a usable embedding configuration, retrieval falls back to keyword and recency matching.
- Retrieved results are ranked primarily by semantic similarity, with importance and vitality breaking ties. The current ranking weights are `0.80` similarity, `0.10` importance, and `0.10` vitality.
- Similar results are deduplicated while they are packed into the prompt. The current packing threshold is cosine similarity `0.70`.

The automatic turn-start recall defaults to a maximum of 10 memories and a shared budget of 20,000 characters. The semantic relevance floor and these limits can be changed under **Settings → Elowen AI**.

`MemorySearch` is also available during a conversation when a fact is needed explicitly. Its default is up to 6 matching memories, subject to the retrieval budget.

### Recall while working

Live recall searches again as the agent moves from your initial request to files, tools, and errors. It is non-blocking: the search starts in the background and its result is injected into a later model call.

Configure the per-account switch at **Account → Memory → Recall while working**. The instance-wide limits are under **Settings → Elowen AI → Limits**:

| Setting | Default | Range |
|---|---:|---:|
| Searches per turn | 10 | 0–20 |
| Memories per batch | 2 | 0–10 |
| Turn byte budget | 20,000 UTF-8 bytes | 10,000–40,000 |

Set **Searches per turn** to `0` to disable live recall. A new steering message resets the live-recall budget for the redirected turn.

## Managing memories

The web interface is at `/memory`. It provides a searchable list, status filters, category filters, sorting, a scalable brain map, memory details, and owner-scoped maintenance controls.

From the workspace you can create, edit, categorize, merge, restore, or delete memories. The deleted-memory view also supports permanent purge and emptying the trash; those operations cannot be undone.

Every memory has:

- a self-contained body;
- a `kind` label, such as `fact`, `preference`, `decision`, or `feedback`;
- an importance from 1 to 5;
- a category, which controls whether it can be recalled.

### Memory tools

There is no standalone `elowen memory` CLI command. In terminal chat and other supported Elowen sessions, memory is managed with these tools:

| Tool | Use |
|---|---|
| `MemorySearch(query, limit?)` | Search relevant memories. Default limit: 6. |
| `MemoryAdd(body, kind?, importance?)` | Store one durable fact. Default importance: 3. |
| `MemoryUpdate(id, body?, kind?, importance?)` | Correct or re-rank one existing memory. |
| `MemoryMerge(ids, body)` | Replace several memories with one consolidated memory. |
| `MemoryDelete(id)` | Soft-delete one memory so it is no longer recalled. |
| `MemoryListRecent(limit?)` | List the newest memories. Default limit: 10. |
| `MemoryCategories()` | List your categories. |
| `MemoryCategoryCreate(name, description?, icon?)` | Create a category. |
| `MemoryCategoryDelete(id)` | Delete a category without deleting its memories. |
| `MemoryRecategorize(all?)` | Re-run automatic categorization. `all: true` includes already categorized memories. |

`MemoryAdd` always writes the new memory. If it resembles an existing memory, it reports the matching id; decide whether to keep both, update one, merge them, or delete the new one. Similarity warnings do not block storage.

## Categories and project scope

A memory must belong to a category to be recalled. Categories are private to your account and have a unique name, an optional description, an optional icon, and an optional project binding.

The category description is the classifier's guide. Make it specific about what belongs there, for example:

```text
Deployment layout, service topology, DNS records, and hosting details. No secrets.
```

New memories are categorized asynchronously in the background. If a memory is uncategorized, it remains stored but is not recallable. `MemoryRecategorize` can classify uncategorized memories after you create categories; use `all: true` when you deliberately want to re-sort existing assignments. Automatic categorization requires a categorization model configured under **Settings → Memory**.

When a memory is added during work in a project:

- the classifier chooses among the user's existing categories;
- if classification produces no category, Elowen uses the project's own category as a fallback;
- the project category is created automatically on first use when needed.

For recall, Elowen resolves the current working directory to the most specific matching registered project. A project-bound category is recalled only in that project. Global categories (without a project binding) are also available there. Categories bound to other projects are excluded. Outside a project, only global categories are eligible. The same scope gates semantic, keyword, and recency retrieval; an uncategorized memory is never recalled.

`POST /memory/retrieve` remains an API inspection surface for diagnosing ranking. It can inspect the caller's categorized memories without changing the stricter Project scope used by real chat turns; the current Web workspace does not expose a separate retrieval tab.

To bind or edit a category, open `/memory`, open the category manager, and set **Project scope**. The `MemoryCategoryCreate` tool creates a global category; project binding is available in the web interface.

Deleting a category keeps its memories but makes them uncategorized, so they stop being recalled until categorized again. Category deletion cannot be undone.

## Vitality and automatic retention

Each memory has a vitality score from 0 to 100. Recalling a memory increases its usage signal; unused memories decay according to their importance.

Default half-lives are:

| Importance | Half-life |
|---:|---:|
| 1 | 3 days |
| 2 | 7 days |
| 3 | 14 days |
| 4 | 30 days |
| 5 | Never |

Automatic retention is enabled by default. A daily maintenance sweep soft-deletes memories that are past the grace period and below the vitality floor. The default retention settings are:

| Setting | Default | Range |
|---|---:|---:|
| Retention enabled | On | On/off |
| Grace period | 14 days | 0–365 days |
| Vitality floor | 10 | 0–90 |
| Half-life for importance 1–4 | 3 / 7 / 14 / 30 days | 0–90 days |
| Importance 5 | Never decays or evicts | Read-only |

Set a half-life to `0` for **never**. Configure these values in **Settings → Elowen AI → Memory retention**. Soft-deleted memories remain in the trash and can be restored from `/memory`; permanent purge removes them irreversibly.

## Self-service maintenance

The Memory workspace can run two owner-scoped background jobs:

- **Reindex memories** rebuilds the search vector for every active memory in your account. Configure embeddings first.
- **Recategorize memories** can process only uncategorized memories or review all active memories. Configure a categorization model first.

Jobs continue in the background, report progress and aggregate failure counts, and are private to the signed-in account. Individual failed items are recorded in daemon logs. Starting the same operation while it is already running returns the existing job instead of creating a duplicate. Recategorization rechecks each row before writing, so a manual category change made while the job runs is not blindly overwritten.

The older `POST /memory/reindex` and `POST /memory/reclassify` routes remain available for bounded synchronous/API compatibility. The Web UI uses `/memory/maintenance/*` for complete background work.

## Embedding configuration

Configure the embedding model in **Settings → Memory**. The Settings UI selects a provider and model and accepts an optional vector dimension. Providers and their credentials are managed under **Settings → Elowen AI**.

A usable embedding configuration needs both:

- a non-empty model name; and
- either a configured provider or an explicit OpenAI-compatible `baseUrl`.

Elowen sends embedding requests to `/v1/embeddings`. If `dimensions` is set, every returned vector must have that width. The default configuration is empty, so semantic retrieval is disabled until you configure a model.

The setup wizard can configure this step:

```bash
elowen setup --memory reuse --embedding-model text-embedding-3-small
```

Supported setup flags are:

- `--memory reuse` — reuse an existing provider;
- `--memory openrouter` — configure the OpenRouter provider;
- `--memory skip` — leave embeddings disabled;
- `--memory-key` — provide the OpenRouter key;
- `--embedding-model` — choose the embedding model;
- `--skip-test` — skip the connection test.

The setup defaults recommend `text-embedding-3-small` and the OpenRouter API base `https://openrouter.ai/api/v1`. Run `elowen doctor` to check memory readiness.

When you change the embedding model, existing vectors no longer match the model. Use the codebase and memory reindex actions described below as appropriate.

### Categorization model

Categorization is separate from embeddings. In **Settings → Memory**, choose a provider and model for classification. It can be a less expensive model than the one used for embeddings. Categorization is best-effort; a categorization failure does not prevent a memory from being stored.

## Codebase semantic search

The codebase search feature reuses the configured embedding model for semantic search over indexed repositories:

- `CodebaseSearch` finds code by meaning;
- `CodebaseStatus` reports indexed files, chunks, staleness, and model information;
- `CodebaseReindex` refreshes the index incrementally, or rebuilds it with `full: true`.

After changing the embedding model, check `CodebaseStatus` and run `CodebaseReindex({ full: true })` so the index is rebuilt with the new vectors.

## API and privacy

Memory API routes are caller-owned: a caller can read and modify only its own memories. Embedding and categorization configuration is workspace-level and admin-gated.

The main API surfaces are:

- `GET/POST /memory` — list or create memories;
- `GET/PATCH/DELETE /memory/:id` — inspect, update, or soft-delete one memory;
- `POST /memory/:id/restore` and `DELETE /memory/:id/purge` — restore or permanently purge;
- `POST /memory/merge` — merge memories;
- `GET /memory/categories` and `POST /memory/categories` — list or create categories;
- `PATCH/DELETE /memory/categories/:cid` — edit or delete a category;
- `POST /memory/retrieve` — inspect retrieval for a query through the API;
- `POST /memory/reindex` — synchronously re-embed up to 100 pending memories;
- `GET /memory/maintenance` — read your background maintenance jobs;
- `POST /memory/maintenance/reindex` — start a full active-memory reindex;
- `POST /memory/maintenance/recategorize` — start uncategorized-only or full recategorization;
- `GET/PUT /memory/embedding` and `POST /memory/embedding/test` — inspect, configure, or test embeddings;
- `GET/PUT /memory/categorization` and `POST /memory/reclassify` — inspect, configure, or run categorization.

Do not store passwords, tokens, API keys, or other secrets. The curator is instructed not to save secrets, but explicit `MemoryAdd` and API input are not secret-filtered.

## Good memory hygiene

- Write one self-contained fact, not a conversation excerpt.
- Store the reason behind an architectural decision, not only the final choice.
- Use `MemoryUpdate` when a fact changes; use `MemoryMerge` for duplicate or overlapping memories.
- Give categories precise descriptions and bind project-specific facts to the right project.
- Treat recalled facts as historical context. Verify files, configuration, and external state before relying on them.

[Next: Usage & Costs](usage-costs)
