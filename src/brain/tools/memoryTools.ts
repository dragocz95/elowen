import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { currentIdentity, currentMemoryRecallScope } from '../../plugins/policyContext.js';
import type { MemoryStore, MemoryRow, MemoryPatch } from '../../store/memoryStore.js';
import type { MemoryService } from '../memoryService.js';
import type { MemoryCategoryStore, MemoryCategoryRow } from '../../store/memoryCategoryStore.js';
import { ICON_ALLOWLIST } from '../../store/memoryCategoryStore.js';
import type { MemoryCategorizer } from '../memoryCategorizer.js';

/** The project facts the write path needs: a project id resolves to the row that names the lazily
 *  created project category (bound by id, named by slug). Structural — ProjectStore satisfies it. */
interface MemoryProjectLookup {
  get(id: number): { id: number; slug: string } | null;
}

export interface MemoryToolDeps {
  store: MemoryStore;
  service: MemoryService;
  categories: MemoryCategoryStore;
  categorizer: MemoryCategorizer;
  /** Resolves the current turn's project id (from the recall scope) to a name for the lazy category. */
  projects: MemoryProjectLookup;
}

/** Message returned when a non-owner turn tries to touch memory. Memory is per-user and PRIVATE —
 *  reachable only from your own Elowen chat or your linked platform account. */
const LOCKED = 'Memory is only available to you — in your own Elowen chat or from your linked platform account.';

/** The PI tool text-result shape (mirrors elowenTools). Errors are surfaced as text, never thrown. */
function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }], details: {} };
}

/** The acting user's Elowen ACCOUNT id behind THIS turn, or null when memory must stay locked. Read at
 *  EXECUTE time — never closed over at build time. The invariant: memory is per-user + private — EACH
 *  user reaches only their OWN memory, from their own Elowen chat OR their linked platform account (same
 *  memory across surfaces). The guard is a resolved `elowenUserId`: it keys memory on the verified account,
 *  so a user only ever touches their own — NOT another user's, NOT the operator's. A task-worker has
 *  currentIdentity()===null and an unlinked/anonymous platform sender has no elowenUserId → both locked.
 *  (Gating on `owner` here would have wrongly restricted memory to the single instance operator, locking
 *  every other user out of their own memory.) Never keys on the raw `userId` (the platform id). */
function actingUserId(): number | null {
  const id = currentIdentity();
  if (!id || id.elowenUserId == null) return null;
  return Number.isFinite(id.elowenUserId) ? id.elowenUserId : null;
}

/** One-line rendering of a memory for the model to reason over. */
function renderMemory(m: MemoryRow): string {
  return `#${m.id} [${m.kind} imp:${m.importance}] ${m.body}`;
}

function memorySearch(d: MemoryToolDeps) {
  return defineTool({
    name: 'MemorySearch', label: 'Search memory',
    description: 'Search your long-term memory about the user for durable facts relevant to a query — '
      + 'stable preferences, past decisions, project, infra and environment details stored in earlier '
      + 'conversations. Use it when the task depends on prior work, a standing preference or non-obvious '
      + 'project context; to browse what was stored most recently use MemoryListRecent instead, and to '
      + 'write a new fact use MemoryAdd. Ranking is semantic when an embedding model is configured and '
      + 'degrades to keyword + recency otherwise; `limit` caps how many memories come back (default 6) and '
      + 'the set is additionally trimmed to a character budget, so a vague query can legitimately return '
      + 'nothing even though the fact is stored. Matches are returned as `#id [kind imp:N] body` lines and '
      + 'are counted as recalled; those ids are what MemoryUpdate, MemoryMerge and MemoryDelete take. '
      + 'Memory is per-user: this reads the acting user\'s own memories plus the shared project pools '
      + 'they belong to, from their own Elowen chat or their linked platform account, and it is refused '
      + 'outright for an unlinked sender or a task worker.',
    parameters: Type.Object({
      query: Type.String({ description: 'What to look up' }),
      limit: Type.Optional(Type.Number({ description: 'Max memories to return (default 6)' })),
    }),
    execute: async (_id, p: { query: string; limit?: number }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const { memories } = await d.service.retrieve(userId, p.query, { maxCount: p.limit });
      if (memories.length === 0) return text('No matching memories.');
      // The model asked for these and receives them in full, so the whole set counts as recalled.
      d.service.markRecalled(userId, memories.map((memory) => memory.id));
      return text(memories.map(renderMemory).join('\n'));
    },
  });
}

function memoryAdd(d: MemoryToolDeps) {
  return defineTool({
    name: 'MemoryAdd', label: 'Add memory',
    description: 'Store ONE durable, reusable fact about the user in long-term memory — a stable '
      + 'preference, an architectural or process decision, a project, infra or environment detail worth '
      + 'having in a future conversation. Use it the moment such a fact is discovered or confirmed; do NOT '
      + 'store chit-chat, greetings, secrets, transient task state or anything already obvious from the '
      + 'code. To correct or re-rank a fact that already exists use MemoryUpdate, and to fold several '
      + 'overlapping ones together use MemoryMerge. The memory is always stored; if a very similar one '
      + 'already exists the result names its id as well, so you can merge or delete afterwards when it '
      + 'really was the same fact. `body` must be self-contained (it is read without this conversation), `kind` '
      + 'labels the fact and `importance` (1..5) biases later recall. The memory is filed into a category '
      + 'in the background — inside a project conversation it falls back to the project\'s shared pool '
      + 'when the user shares it, otherwise to the project\'s own category — because an uncategorized '
      + 'memory is never recalled. Memory is per-user, so this '
      + 'is refused for an unlinked platform sender or a task worker.',
    parameters: Type.Object({
      body: Type.String({ description: 'The fact, self-contained — it will be read without this conversation for context. Empty text is rejected.' }),
      kind: Type.Optional(Type.String({ description: "What sort of fact this is: e.g. 'fact', 'preference', 'decision', 'feedback' (default 'fact')" })),
      importance: Type.Optional(Type.Number({ description: 'How strongly this should be recalled, 1..5 (default 3)' })),
    }),
    execute: async (_id, p: { body: string; kind?: string; importance?: number }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const body = p.body.trim();
      if (body === '') return text('Cannot add an empty memory.');
      // The scope is read at EXECUTE time: the cwd can change between turns (/cd), so the project is
      // whatever THIS turn resolves to, never what the session spawned with. Read BEFORE the similarity
      // scan so the scan also covers the shared pool of this project — a neighbour another member stored
      // must be named, not silently duplicated.
      const scope = currentMemoryRecallScope();
      // The similarity check REPORTS, it does not veto. It used to return here without writing, which made
      // a false positive cost the whole memory: the fact was never stored, and the model — told only that
      // something similar exists — had no reason to try again. Measurement (24 Aug 2026, see
      // DEFAULT_SIMILAR_THRESHOLD) showed the signal cannot carry that weight, because on long notes in one
      // voice a high cosine marks a shared topic rather than a restatement. Storing and naming the neighbour
      // points the failure the recoverable way: a redundant memory can still be folded in with MemoryMerge,
      // a memory that was never written is simply gone.
      const near = await d.service.findSimilar(userId, body, { sharedCategoryIds: scope?.sharedCategoryIds });
      const row = d.store.add(
        userId,
        { body, kind: p.kind, importance: p.importance, source: 'user' },
        `user:${userId}`, 'added via MemoryAdd tool',
      );
      // Categorization used to hang off the post-turn curator alone, so a memory the agent stored through
      // this tool stayed uncategorized forever. Same fire-and-forget the curator has always done.
      // A PROJECT turn resolves the category itself instead: the memory must land in the project's bound
      // category — or, when the user shares the project's pool, in the SHARED pool — now, because an
      // uncategorized memory is never recalled — fail-closed — and the background pass would race this
      // default and could clear it.
      const project = scope && scope.projectId !== null ? d.projects.get(scope.projectId) : undefined;
      if (project) {
        void categorizeNewMemoryForProject(d, userId, row, project).catch(() => {
          // Best-effort like the fire-and-forget path: a failed categorization must never fail the add.
          // The memory stays uncategorized (never recalled) rather than leaking into another project.
        });
      } else {
        d.categorizer.classifyNewMemory(userId, row.id, `user:${userId}`);
      }
      if (near.length === 0) return text(`Stored memory #${row.id}.`);
      // Named, not quoted: the neighbour can be thousands of characters, and the model needs the id to act
      // on it, not the text to re-read. MemorySearch fetches the body if the decision actually needs it.
      const top = near[0]!;
      return text(`Stored memory #${row.id}. It resembles #${top.memory.id} (similarity `
        + `${top.similarity.toFixed(2)}) — if this restates the same fact rather than adding a new one, `
        + `fold them together with MemoryMerge, or drop this one with MemoryDelete.`);
    },
  });
}

/** The category bound to this project — bound by ID, never matched by name — created on first use
 *  named after the project. A UNIQUE(user_id, name) collision (the user already owns a category with
 *  the project's name, e.g. a global one) is disambiguated with a " (project)" suffix; the existing
 *  name-match is never reused, since rebinding it would silently change ITS scope. */
function ensureProjectCategory(
  d: MemoryToolDeps,
  userId: number,
  project: { id: number; slug: string },
): MemoryCategoryRow {
  const existing = d.categories.list(userId).find((c) => c.projectId === project.id);
  if (existing) return existing;
  try {
    return d.categories.create(userId, { name: project.slug, projectId: project.id });
  } catch {
    // A concurrent first-add (the partial unique index on user_id+project_id) or a name collision.
    // Re-read to pick up a concurrently created binding; otherwise retry once under a distinct name.
    const concurrent = d.categories.list(userId).find((c) => c.projectId === project.id);
    if (concurrent) return concurrent;
    return d.categories.create(userId, { name: `${project.slug} (project)`, projectId: project.id });
  }
}

/** File a just-stored memory inside a project conversation. When the user SHARES the project's memory
 *  pool, the pool is the fallback (and among the classifier's options) — the fact lands where the whole
 *  team can recall it. Otherwise the personal project category applies. The classifier decides first and
 *  its pick wins; when it is silent (no match, no model wired, or a relay error) the memory falls back to
 *  the pool/project category — created here on first use — so a project memory is never left
 *  uncategorized (uncategorized memories are never recalled — fail-closed). Fire-and-forget from the
 *  caller, but the fallback can only be applied once the classifier's verdict is known, so this must
 *  run inline instead of via the usual background classifyNewMemory. */
async function categorizeNewMemoryForProject(
  d: MemoryToolDeps,
  userId: number,
  row: MemoryRow,
  project: { id: number; slug: string },
): Promise<void> {
  // Resolved (and lazily created) BEFORE the classifier runs so the shared pool is among its options.
  // NULL when the user does not share the pool — then the personal project category applies unchanged.
  const sharedCategory = d.categories.sharedForProject(userId, project);
  if (sharedCategory) {
    let classified: number | null = null;
    try {
      classified = await d.categorizer.classify(userId, row.body, [sharedCategory]);
    } catch {
      // Relay error → treat as silent and fall through to the pool default (never fail the add).
    }
    d.store.setCategory(userId, row.id, classified ?? sharedCategory.id, `user:${userId}`, 'MemoryAdd: shared project pool');
    return;
  }
  // Created BEFORE the classifier runs so the project's own category is among its options.
  const projectCategory = ensureProjectCategory(d, userId, project);
  let classified: number | null = null;
  try {
    classified = await d.categorizer.classify(userId, row.body);
  } catch {
    // Relay error → treat as silent and fall through to the project default (never fail the add).
  }
  d.store.setCategory(userId, row.id, classified ?? projectCategory.id, `user:${userId}`, 'MemoryAdd: project default');
}

function memoryUpdate(d: MemoryToolDeps) {
  return defineTool({
    name: 'MemoryUpdate', label: 'Update memory',
    description: 'Revise ONE existing long-term memory in place, addressed by its id — correct a fact that '
      + 'has changed, relabel its kind, or re-rank how strongly it is recalled. Use this whenever current '
      + 'evidence contradicts something stored, so a stale and a corrected version never coexist; use '
      + 'MemoryAdd only for a genuinely new fact, MemoryMerge to collapse several redundant ones, and '
      + 'MemoryDelete when the fact should stop being recalled entirely. The id comes from MemorySearch or '
      + 'MemoryListRecent; only the fields you pass are changed, the rest are left alone. An unknown id is '
      + 'reported back as "no memory found" rather than creating anything, and the tool is refused for an '
      + 'unlinked platform sender or a task worker because memory is per-user and private.',
    parameters: Type.Object({
      id: Type.Number({ description: 'The memory id to update, as shown by MemorySearch or MemoryListRecent' }),
      body: Type.Optional(Type.String({ description: 'Replacement text for the fact, self-contained. Omit to keep the current wording.' })),
      kind: Type.Optional(Type.String({ description: "Replacement label, e.g. 'fact', 'preference', 'decision', 'feedback'. Omit to keep it." })),
      importance: Type.Optional(Type.Number({ description: 'New recall weight, 1..5. Omit to keep the current one.' })),
    }),
    execute: async (_id, p: { id: number; body?: string; kind?: string; importance?: number }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const patch: MemoryPatch = {};
      if (p.body !== undefined) patch.body = p.body;
      if (p.kind !== undefined) patch.kind = p.kind;
      if (p.importance !== undefined) patch.importance = p.importance;
      const row = d.store.update(userId, p.id, patch, `user:${userId}`, 'updated via MemoryUpdate tool');
      if (!row) return text(`No memory #${p.id} found.`);
      return text(`Updated memory #${row.id}.`);
    },
  });
}

function memoryMerge(d: MemoryToolDeps) {
  return defineTool({
    name: 'MemoryMerge', label: 'Merge memories',
    description: 'Collapse several redundant memories — paraphrases of one fact, or a fact and its later '
      + 'correction — into a single consolidated memory. Use it after MemorySearch or MemoryListRecent '
      + 'shows the same thing stored more than once; for a single memory that is merely wrong use '
      + 'MemoryUpdate instead. Every id in `ids` is soft-deleted and `body` is stored as a NEW memory whose '
      + 'id is returned, so the sources stop being recalled and there is no tool that brings them back — '
      + 'write the consolidated text before calling. An empty `body` or an empty `ids` list is rejected, '
      + 'and the whole tool is refused for an unlinked platform sender or a task worker.',
    parameters: Type.Object({
      ids: Type.Array(Type.Number(), { description: 'The source memory ids to merge — all of them are soft-deleted by this call' }),
      body: Type.String({ description: 'The consolidated fact, self-contained — stored as a new memory replacing the sources' }),
    }),
    execute: async (_id, p: { ids: number[]; body: string }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const body = p.body.trim();
      if (body === '') return text('Cannot merge into an empty memory.');
      if (p.ids.length === 0) return text('Provide at least one source memory id to merge.');
      const merged = d.store.merge(userId, p.ids, body, `user:${userId}`, 'merged via MemoryMerge tool');
      return text(`Merged into memory #${merged.id}.`);
    },
  });
}

function memoryDelete(d: MemoryToolDeps) {
  return defineTool({
    name: 'MemoryDelete', label: 'Delete memory',
    description: 'Delete ONE long-term memory by id so it stops being recalled — use it when the user asks '
      + 'you to forget something, or when a stored fact is obsolete and nothing should replace it. Prefer '
      + 'MemoryUpdate when the fact merely changed and MemoryMerge when it is a duplicate; both keep the '
      + 'knowledge, this one removes it. The delete is a soft delete (the row is retained for audit) but it '
      + 'is irreversible from your side: no tool restores a deleted memory, so confirm the id with '
      + 'MemorySearch or MemoryListRecent before calling, and delete one memory per call. An unknown id '
      + 'reports "no memory found" and changes nothing; the tool is refused for an unlinked platform sender '
      + 'or a task worker, since memory is per-user and private.',
    parameters: Type.Object({ id: Type.Number({ description: 'The memory id to delete, from MemorySearch or MemoryListRecent — deletion cannot be undone' }) }),
    execute: async (_id, p: { id: number }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const ok = d.store.softDelete(userId, p.id, `user:${userId}`, 'deleted via MemoryDelete tool');
      return text(ok ? `Deleted memory #${p.id}.` : `No memory #${p.id} found.`);
    },
  });
}

function memoryListRecent(d: MemoryToolDeps) {
  return defineTool({
    name: 'MemoryListRecent', label: 'List recent memories',
    description: 'List the most recently stored memories about the user, newest first, without a query — '
      + 'the right tool when the user asks what you remember or what was saved lately, and a quick way to '
      + 'find an id before MemoryUpdate, MemoryMerge or MemoryDelete. When you are looking for facts about '
      + 'a specific topic use MemorySearch instead; this one ranks nothing and simply returns the latest '
      + 'entries. It is scoped to the categories recalled in this conversation, so memories that are '
      + 'uncategorized — or belong to another project\'s category — do not appear here even though they '
      + 'exist; an empty result is not proof that nothing is stored. Rows are rendered as `#id [kind '
      + 'imp:N] body`, `limit` caps how many are returned (default 10), and the tool is refused for an '
      + 'unlinked platform sender or a task worker because memory is per-user and private.',
    parameters: Type.Object({ limit: Type.Optional(Type.Number({ description: 'Max memories to list, newest first (default 10)' })) }),
    execute: async (_id, p: { limit?: number }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const rows = d.service.listRecent(userId, p.limit ?? 10);
      if (rows.length === 0) return text('No memories stored yet.');
      return text(rows.map(renderMemory).join('\n'));
    },
  });
}

function memoryCategories(d: MemoryToolDeps) {
  return defineTool({
    name: 'MemoryCategories', label: 'List memory categories',
    description: 'List the user\'s memory categories — the folders long-term memories are sorted into — '
      + 'with each category\'s id, name and the description the auto-classifier matches memories against. '
      + 'Use it before MemoryCategoryCreate so you do not add a near-duplicate category, and to get the id '
      + 'MemoryCategoryDelete needs; to list the memories themselves use MemoryListRecent or MemorySearch. '
      + 'It takes no arguments and returns `#id name — description` lines, or a note that no category '
      + 'exists yet. Categories are per-user and private, so the tool is refused for an unlinked platform '
      + 'sender or a task worker.',
    parameters: Type.Object({}),
    execute: async () => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      const cats = d.categories.list(userId);
      if (cats.length === 0) return text('No memory categories yet. Create one with MemoryCategoryCreate.');
      return text(cats.map((c) => `#${c.id} ${c.name}${c.description ? ` — ${c.description}` : ''}`).join('\n'));
    },
  });
}

function memoryCategoryCreate(d: MemoryToolDeps) {
  return defineTool({
    name: 'MemoryCategoryCreate', label: 'Create memory category',
    description: 'Create a new memory category — a folder the auto-classifier files long-term memories '
      + 'into. Use it when the user wants their memories organized by a topic that does not exist yet; '
      + 'call MemoryCategories first to see what is already there, because a name that is already taken is '
      + 'rejected rather than reused. `description` is the guide the classifier matches memories against, '
      + 'so state specifically what belongs here — a vague guide means memories land elsewhere. `icon` is '
      + `optional (a lucide name from: ${ICON_ALLOWLIST.join(', ')}; anything else falls back to a folder), `
      + 'and an empty name is rejected. Creating a category sorts nothing by itself: run MemoryRecategorize '
      + 'afterwards to move existing memories into it. Per-user and private, so the tool is refused for an '
      + 'unlinked platform sender or a task worker.',
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
        return text(`Created category #${row.id} "${row.name}". Run MemoryRecategorize to sort memories into it.`);
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
    name: 'MemoryCategoryDelete', label: 'Delete memory category',
    description: 'Delete ONE memory category by id — the folder only, never the memories in it. Use it '
      + 'when a category is redundant or was created by mistake; to remove an actual fact use MemoryDelete '
      + 'instead, and to move memories somewhere else create the better category first and run '
      + 'MemoryRecategorize. The memories that lived here become UNCATEGORIZED, which means they stop '
      + 'being recalled until something files them again — so deleting a category quietly takes its '
      + 'memories out of circulation, and there is no tool that undoes it. Get the id from '
      + 'MemoryCategories; an unknown id reports "no category" and changes nothing. Refused for an '
      + 'unlinked platform sender or a task worker, since memory is per-user and private.',
    parameters: Type.Object({ id: Type.Number({ description: 'Category id from MemoryCategories — the category is removed permanently, its memories become uncategorized' }) }),
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
    name: 'MemoryRecategorize', label: 'Recategorize memories',
    description: 'Re-run the auto-classifier over the user\'s stored memories and file them into the '
      + 'categories that exist now. Use it after creating or reworking a category with '
      + 'MemoryCategoryCreate, or when memories are not being recalled because they were never '
      + 'categorized; it changes only which category each memory belongs to, never the facts themselves. '
      + 'By default only UNcategorized memories are touched — set `all: true` to re-sort every memory, '
      + 'which can move memories out of the category they are in today. It refuses when no categorization '
      + 'model is configured (Settings → memory model) or when no category exists yet, and it reports how '
      + 'many memories were scanned and how many were sorted. Personal and per-user, so it is refused for '
      + 'an unlinked platform sender or a task worker.',
    parameters: Type.Object({
      all: Type.Optional(Type.Boolean({ description: 'Re-sort EVERY memory, not just the uncategorized ones — existing category assignments may change (default false)' })),
    }),
    execute: async (_id, p: { all?: boolean }) => {
      const userId = actingUserId();
      if (userId === null) return text(LOCKED);
      if (!d.categorizer.configured()) return text('No categorization model is configured (Settings → memory model), so memories can\'t be auto-sorted.');
      if (d.categories.list(userId).length === 0) return text('No categories to sort into. Create one with MemoryCategoryCreate first.');
      const { scanned, classified } = await d.categorizer.reclassify(userId, { includeCategorized: p.all === true });
      return text(`Scanned ${scanned} memor${scanned === 1 ? 'y' : 'ies'}, sorted ${classified} into a category.`);
    },
  });
}

/** The per-user private long-term memory toolset. EVERY tool re-derives the acting user from
 *  currentIdentity() at execute time and refuses any turn without a resolved elowenUserId (an unlinked/
 *  anonymous sender or a task-worker) — the build-time caller must NEVER close over a user id (that would
 *  leak into another sender's turn in a shared channel). Composed into every interactive session (see
 *  composeSessionTools); the per-tool elowenUserId check is the real guard, keying each user to their own. */
export function buildMemoryTools(d: MemoryToolDeps) {
  return [
    memorySearch(d), memoryAdd(d), memoryUpdate(d), memoryMerge(d), memoryDelete(d), memoryListRecent(d),
    memoryCategories(d), memoryCategoryCreate(d), memoryCategoryDelete(d), memoryRecategorize(d),
  ];
}
