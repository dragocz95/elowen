import type { MemoryCategoryStore, MemoryCategoryRow } from '../store/memoryCategoryStore.js';
import type { MemoryStore } from '../store/memoryStore.js';
import type { InferenceClient } from '../inference/types.js';
import type { Logger } from '../shared/logger.js';

/** Hard cap on how many memories one manual reclassify pass touches — bounds the relay round-trips a
 *  single owner-triggered pass can fan out. */
const MAX_RECLASSIFY = 200;
/** How much of each memory body the classify prompt sees — a category decision never needs the full
 *  body, and this bounds the relay round-trip. */
const MAX_BODY_CHARS = 2000;

/** Assigns a user's RAW memories to ONE of their own categories using a cheap model. Best-effort by
 *  design: every per-memory failure is swallowed + logged so it can ride fire-and-forget from the
 *  curator (never throws into the op batch) and never wedge a manual reclassify. The categorizer NEVER
 *  invents a category — it only ever picks an existing id or clears to null. Category persistence goes
 *  through MemoryStore.setCategory (owner-scoped, audited 'categorize'); the model here is a pure
 *  decision function. Categorization disabled (no model wired / provider key missing) → every method
 *  no-ops. Memory is per-user; the caller passes the genuine owner's id. */
export class MemoryCategorizer {
  private readonly categories: MemoryCategoryStore;
  private readonly memories: MemoryStore;
  private readonly inference: () => InferenceClient | null;
  private readonly logger?: Logger;

  constructor(deps: {
    categories: MemoryCategoryStore;
    memories: MemoryStore;
    inference: () => InferenceClient | null; // null when categorization unconfigured / provider-key missing
    logger?: Logger;
  }) {
    this.categories = deps.categories;
    this.memories = deps.memories;
    this.inference = deps.inference;
    this.logger = deps.logger;
  }

  /** True when a categorization model is wired (inference() resolves). The route uses it to 400 cleanly
   *  before attempting a reclassify. */
  configured(): boolean {
    return this.inference() !== null;
  }

  /** Pure decision: pick ONE existing category id for `body`, or null. NEVER invents a category. Returns
   *  null when there are no categories, no model wired, or the model reply matches nothing / says "none".
   *  May throw on a relay error — callers (classifyMemory / reclassify) wrap it. */
  async classify(userId: number, body: string): Promise<number | null> {
    const cats = this.categories.list(userId);
    if (cats.length === 0) return null;
    const inf = this.inference();
    if (!inf) return null;
    const { text } = await inf.decide(buildClassifyPrompt(body.slice(0, MAX_BODY_CHARS), cats));
    return coerceCategory(text, cats);
  }

  /** Load one memory, classify it, and persist via memories.setCategory ONLY if the category id changed.
   *  Best-effort: swallows + logs every failure (fire-and-forget safe from the curator). Skips memories
   *  that aren't active. */
  async classifyMemory(userId: number, memoryId: number, actor: string): Promise<void> {
    try {
      const mem = this.memories.get(userId, memoryId);
      if (!mem || mem.status !== 'active') return;
      const catId = await this.classify(userId, mem.body);
      if (catId !== mem.category_id) {
        this.memories.setCategory(userId, memoryId, catId, actor, 'categorizer: auto-classified');
      }
    } catch (err) {
      this.logger?.warn('memory categorizer failed', { userId, memoryId, error: String(err) });
    }
  }

  /** Batch (re)classify the user's active memories, capped at MAX_RECLASSIFY. By default only touches
   *  uncategorized rows (categoryId:null filter); `includeCategorized` re-tags everything. Each memory is
   *  best-effort — one failure is logged and skipped, never aborting the pass. Returns { scanned,
   *  classified } where `classified` counts rows that landed on a non-null category. */
  async reclassify(userId: number, opts?: { limit?: number; includeCategorized?: boolean }): Promise<{ scanned: number; classified: number }> {
    const inf = this.inference();
    if (!inf) return { scanned: 0, classified: 0 };
    if (this.categories.list(userId).length === 0) return { scanned: 0, classified: 0 };
    const limit = Math.min(opts?.limit ?? MAX_RECLASSIFY, MAX_RECLASSIFY);
    const rows = this.memories.list(userId, opts?.includeCategorized
      ? { status: 'active', limit }
      : { status: 'active', categoryId: null, limit });
    let classified = 0;
    for (const m of rows) {
      try {
        const catId = await this.classify(userId, m.body);
        if (catId !== m.category_id) {
          this.memories.setCategory(userId, m.id, catId, `user:${userId}`, 'categorizer: reclassified');
        }
        if (catId !== null) classified += 1;
      } catch (err) {
        this.logger?.warn('memory reclassify op failed', { userId, memoryId: m.id, error: String(err) });
      }
    }
    return { scanned: rows.length, classified };
  }
}

/** The classify prompt: strict single-token reply, Czech-friendly, mirrors memoryCurator's tone. Lists
 *  every category as `- <name>: <description>` so the model classifies against the descriptions, and
 *  forbids inventing a new category. */
function buildClassifyPrompt(body: string, cats: MemoryCategoryRow[]): string {
  return [
    'Jsi klasifikátor paměti asistenta Orca. Zařaď následující vzpomínku do PRÁVĚ JEDNÉ z kategorií níže.',
    'Rozhoduj se podle popisu každé kategorie. Když se nehodí žádná, odpověz slovem "none".',
    'Odpověz POUZE názvem kategorie (přesně jak je uveden), bez dalšího textu. Nevymýšlej nové kategorie.',
    '',
    'Kategorie:',
    cats.map((c) => `- ${c.name}: ${c.description}`).join('\n'),
    '',
    `Vzpomínka: ${body}`,
  ].join('\n');
}

/** Escape a string for safe interpolation into a RegExp source (category names are user-supplied). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Coerce the model's reply to a KNOWN category id, or null. Strips a ```fence / surrounding quotes,
 *  lowercases, treats "none"/"null"/empty as null. Prefers an exact full-string name match; otherwise a
 *  whole-token match (the category name appearing as a standalone token-run inside a longer reply). No
 *  match → null (falls back to uncategorized). Never throws. */
function coerceCategory(reply: string, cats: MemoryCategoryRow[]): number | null {
  const cleaned = reply
    .trim()
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/```$/, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
    .toLowerCase();
  if (cleaned === '' || cleaned === 'none' || cleaned === 'null') return null;
  // Exact full-string equality first — the model followed the "reply with ONLY the name" instruction.
  for (const c of cats) {
    if (c.name.trim().toLowerCase() === cleaned) return c.id;
  }
  // Else a whole-token hit: the name occurs as a standalone token-run somewhere in the reply.
  for (const c of cats) {
    const name = c.name.trim().toLowerCase();
    if (name === '') continue;
    if (new RegExp(`(?:^|\\W)${escapeRegExp(name)}(?:\\W|$)`).test(cleaned)) return c.id;
  }
  return null;
}
