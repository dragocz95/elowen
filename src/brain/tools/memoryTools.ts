import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { currentIdentity } from '../../plugins/policyContext.js';
import type { MemoryStore, MemoryRow, MemoryPatch } from '../../store/memoryStore.js';
import type { MemoryService } from '../memoryService.js';
import type { MemoryCategoryStore } from '../../store/memoryCategoryStore.js';
import { ICON_ALLOWLIST } from '../../store/memoryCategoryStore.js';
import type { MemoryCategorizer } from '../memoryCategorizer.js';

export interface MemoryToolDeps {
  store: MemoryStore;
  service: MemoryService;
  categories: MemoryCategoryStore;
  categorizer: MemoryCategorizer;
}

/** Message returned when a non-owner turn tries to touch memory. Memory is per-user and PRIVATE —
 *  reachable only from your own Orca chat or your linked platform account. */
const LOCKED = 'Memory is only available to you — in your own Orca chat or from your linked platform account.';

/** The PI tool text-result shape (mirrors orcaTools). Errors are surfaced as text, never thrown. */
function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }], details: {} };
}

/** The acting user's Orca ACCOUNT id behind THIS turn, or null when memory must stay locked. Read at
 *  EXECUTE time — never closed over at build time. The invariant: memory is per-user + private — EACH
 *  user reaches only their OWN memory, from their own Orca chat OR their linked platform account (same
 *  memory across surfaces). The guard is a resolved `orcaUserId`: it keys memory on the verified account,
 *  so a user only ever touches their own — NOT another user's, NOT the operator's. A task-worker has
 *  currentIdentity()===null and an unlinked/anonymous platform sender has no orcaUserId → both locked.
 *  (Gating on `owner` here would have wrongly restricted memory to the single instance operator, locking
 *  every other user out of their own memory.) Never keys on the raw `userId` (the platform id). */
function actingUserId(): number | null {
  const id = currentIdentity();
  if (!id || id.orcaUserId == null) return null;
  return Number.isFinite(id.orcaUserId) ? id.orcaUserId : null;
}

/** One-line rendering of a memory for the model to reason over. */
function renderMemory(m: MemoryRow): string {
  return `#${m.id} [${m.kind} imp:${m.importance}] ${m.body}`;
}

function memorySearch(d: MemoryToolDeps) {
  return defineTool({
    name: 'memory_search', label: 'Search memory',
    description: 'Search your long-term memory about the user for durable facts relevant to a query '
      + '(stable preferences, decisions, project/infra details). Semantic when embeddings are configured, '
      + 'keyword otherwise. Only usable in the user\'s personal chat.',
    parameters: Type.Object({
      query: Type.String({ description: 'What to look up' }),
      limit: Type.Optional(Type.Number({ description: 'Max memories to return (default 6)' })),
    }),
    execute: async (_id, p: { query: string; limit?: number }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const { memories } = await d.service.retrieve(userId, p.query, { maxCount: p.limit });
      if (memories.length === 0) return text('No matching memories.');
      return text(memories.map(renderMemory).join('\n'));
    },
  });
}

function memoryAdd(d: MemoryToolDeps) {
  return defineTool({
    name: 'memory_add', label: 'Add memory',
    description: 'Store ONE durable, reusable fact about the user (a stable preference, a decision, a '
      + 'project/infra detail). Do NOT store chit-chat, greetings or transient state. Before inserting, '
      + 'this checks for a near-duplicate — if one exists it does NOT insert and returns the existing id '
      + 'so you can memory_update or memory_merge instead of piling up paraphrases. Personal chat only.',
    parameters: Type.Object({
      body: Type.String({ description: 'The fact, self-contained' }),
      kind: Type.Optional(Type.String({ description: "e.g. 'fact', 'preference', 'decision' (default 'fact')" })),
      importance: Type.Optional(Type.Number({ description: '1..5 (default 3)' })),
    }),
    execute: async (_id, p: { body: string; kind?: string; importance?: number }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const body = p.body.trim();
      if (body === '') return text('Cannot add an empty memory.');
      const near = await d.service.findSimilar(userId, body);
      if (near.length > 0) {
        const top = near[0]!;
        return text(`A near-duplicate memory already exists (#${top.memory.id}, similarity `
          + `${top.similarity.toFixed(2)}): "${top.memory.body}". Prefer memory_update #${top.memory.id} `
          + 'or memory_merge instead of adding a duplicate.');
      }
      const row = d.store.add(
        userId,
        { body, kind: p.kind, importance: p.importance, source: 'user' },
        `user:${userId}`, 'added via memory_add tool',
      );
      return text(`Stored memory #${row.id}.`);
    },
  });
}

function memoryUpdate(d: MemoryToolDeps) {
  return defineTool({
    name: 'memory_update', label: 'Update memory',
    description: 'Revise an existing memory by id — correct the fact, change its kind, or re-rank its '
      + 'importance (1..5). Prefer this over adding a paraphrase. Personal chat only.',
    parameters: Type.Object({
      id: Type.Number({ description: 'The memory id to update' }),
      body: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      importance: Type.Optional(Type.Number({ description: '1..5' })),
    }),
    execute: async (_id, p: { id: number; body?: string; kind?: string; importance?: number }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const patch: MemoryPatch = {};
      if (p.body !== undefined) patch.body = p.body;
      if (p.kind !== undefined) patch.kind = p.kind;
      if (p.importance !== undefined) patch.importance = p.importance;
      const row = d.store.update(userId, p.id, patch, `user:${userId}`, 'updated via memory_update tool');
      if (!row) return text(`No memory #${p.id} found.`);
      return text(`Updated memory #${row.id}.`);
    },
  });
}

function memoryMerge(d: MemoryToolDeps) {
  return defineTool({
    name: 'memory_merge', label: 'Merge memories',
    description: 'Collapse several redundant memories into one consolidated fact. The source ids are '
      + 'soft-deleted; the merged body becomes a new memory. Personal chat only.',
    parameters: Type.Object({
      ids: Type.Array(Type.Number(), { description: 'The source memory ids to merge' }),
      body: Type.String({ description: 'The consolidated fact' }),
    }),
    execute: async (_id, p: { ids: number[]; body: string }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const body = p.body.trim();
      if (body === '') return text('Cannot merge into an empty memory.');
      if (p.ids.length === 0) return text('Provide at least one source memory id to merge.');
      const merged = d.store.merge(userId, p.ids, body, `user:${userId}`, 'merged via memory_merge tool');
      return text(`Merged into memory #${merged.id}.`);
    },
  });
}

function memoryDelete(d: MemoryToolDeps) {
  return defineTool({
    name: 'memory_delete', label: 'Delete memory',
    description: 'Soft-delete a memory by id (it is retained for audit, just no longer recalled). '
      + 'Personal chat only.',
    parameters: Type.Object({ id: Type.Number({ description: 'The memory id to delete' }) }),
    execute: async (_id, p: { id: number }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const ok = d.store.softDelete(userId, p.id, `user:${userId}`, 'deleted via memory_delete tool');
      return text(ok ? `Deleted memory #${p.id}.` : `No memory #${p.id} found.`);
    },
  });
}

function memoryListRecent(d: MemoryToolDeps) {
  return defineTool({
    name: 'memory_list_recent', label: 'List recent memories',
    description: 'List the most recently stored memories about the user. Personal chat only.',
    parameters: Type.Object({ limit: Type.Optional(Type.Number({ description: 'Max to list (default 10)' })) }),
    execute: async (_id, p: { limit?: number }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const rows = d.store.listRecent(userId, p.limit ?? 10);
      if (rows.length === 0) return text('No memories stored yet.');
      return text(rows.map(renderMemory).join('\n'));
    },
  });
}

function memoryCategories(d: MemoryToolDeps) {
  return defineTool({
    name: 'memory_categories', label: 'List memory categories',
    description: 'List your memory categories — each id, name and the guide the auto-classifier matches '
      + 'memories against. Use this before creating (avoid duplicates) or deleting one. Personal chat only.',
    parameters: Type.Object({}),
    execute: async () => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const cats = d.categories.list(userId);
      if (cats.length === 0) return text('No memory categories yet. Create one with memory_category_create.');
      return text(cats.map((c) => `#${c.id} ${c.name}${c.description ? ` — ${c.description}` : ''}`).join('\n'));
    },
  });
}

function memoryCategoryCreate(d: MemoryToolDeps) {
  return defineTool({
    name: 'memory_category_create', label: 'Create memory category',
    description: 'Create a new memory category. `description` is the guide the auto-classifier matches '
      + 'memories against, so make it specific about what belongs here. `icon` is optional (a lucide name '
      + `from: ${ICON_ALLOWLIST.join(', ')}; anything else falls back to a folder). Fails if the name `
      + 'already exists — call memory_categories first. Personal chat only.',
    parameters: Type.Object({
      name: Type.String({ description: 'Short category name (unique)' }),
      description: Type.Optional(Type.String({ description: 'What belongs here — the classifier guide' })),
      icon: Type.Optional(Type.String({ description: 'Optional lucide icon name from the allowed set' })),
    }),
    execute: async (_id, p: { name: string; description?: string; icon?: string }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const name = p.name.trim();
      if (name === '') return text('A category needs a name.');
      try {
        const row = d.categories.create(userId, { name, description: p.description?.trim(), icon: p.icon });
        return text(`Created category #${row.id} "${row.name}". Run memory_recategorize to sort memories into it.`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/UNIQUE|constraint/i.test(msg)) return text(`A category named "${name}" already exists.`);
        return text(`Could not create the category: ${msg}`);
      }
    },
  });
}

function memoryCategoryDelete(d: MemoryToolDeps) {
  return defineTool({
    name: 'memory_category_delete', label: 'Delete memory category',
    description: 'Delete a memory category by id. Its memories are NOT deleted — they just become '
      + 'uncategorized. Personal chat only.',
    parameters: Type.Object({ id: Type.Number({ description: 'Category id (from memory_categories)' }) }),
    execute: async (_id, p: { id: number }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const ok = d.categories.delete(userId, p.id);
      return text(ok ? `Deleted category #${p.id}. Its memories are now uncategorized.` : `No category #${p.id}.`);
    },
  });
}

function memoryRecategorize(d: MemoryToolDeps) {
  return defineTool({
    name: 'memory_recategorize', label: 'Recategorize memories',
    description: 'Re-run the auto-classifier over your memories to sort them into the current categories. '
      + 'By default only UNcategorized memories are touched; set `all: true` to re-sort every memory '
      + '(e.g. after adding or renaming categories). Personal chat only.',
    parameters: Type.Object({
      all: Type.Optional(Type.Boolean({ description: 'Re-sort every memory, not just uncategorized ones' })),
    }),
    execute: async (_id, p: { all?: boolean }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      if (!d.categorizer.configured()) return text('No categorization model is configured (Settings → memory model), so memories can\'t be auto-sorted.');
      if (d.categories.list(userId).length === 0) return text('No categories to sort into. Create one with memory_category_create first.');
      const { scanned, classified } = await d.categorizer.reclassify(userId, { includeCategorized: p.all === true });
      return text(`Scanned ${scanned} memor${scanned === 1 ? 'y' : 'ies'}, sorted ${classified} into a category.`);
    },
  });
}

/** The per-user private long-term memory toolset. EVERY tool re-derives the acting user from
 *  currentIdentity() at execute time and refuses any turn without a resolved orcaUserId (an unlinked/
 *  anonymous sender or a task-worker) — the build-time caller must NEVER close over a user id (that would
 *  leak into another sender's turn in a shared channel). Composed into every interactive session (see
 *  composeSessionTools); the per-tool orcaUserId check is the real guard, keying each user to their own. */
export function buildMemoryTools(d: MemoryToolDeps) {
  return [
    memorySearch(d), memoryAdd(d), memoryUpdate(d), memoryMerge(d), memoryDelete(d), memoryListRecent(d),
    memoryCategories(d), memoryCategoryCreate(d), memoryCategoryDelete(d), memoryRecategorize(d),
  ];
}
