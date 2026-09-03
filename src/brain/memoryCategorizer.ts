import type { MemoryCategoryStore, MemoryCategoryRow } from '../store/memoryCategoryStore.js';
import { ICON_ALLOWLIST, DEFAULT_ICON, memoryCategoryFingerprint } from '../store/memoryCategoryStore.js';
import { hashBody, type MemoryStore } from '../store/memoryStore.js';
import type { InferenceClient } from '../inference/types.js';
import type { Logger } from '../shared/logger.js';
import { containsWholeToken } from '../shared/text.js';

/** Hard cap on how many memories one manual reclassify pass touches — bounds the relay round-trips a
 *  single owner-triggered pass can fan out. */
const MAX_RECLASSIFY = 200;
/** How much of each memory body the classify prompt sees — a category decision never needs the full
 *  body, and this bounds the relay round-trip. */
const MAX_BODY_CHARS = 2000;

export interface MemoryCategoryDecision {
  categoryId: number | null;
  categoryFingerprint: string | null;
  model: string | null;
}

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

  /** Whether this owner has at least one valid target category. Maintenance refuses a no-op run before
   * snapshotting hundreds of memories; the UI uses the same category query to disable the action. */
  hasCategories(userId: number): boolean {
    return this.categories.list(userId).length > 0;
  }

  /** Model currently backing categorization. Captured before each maintenance item so its audit names the
   * decision source even if workspace settings change while inference is in flight. */
  currentModel(): string | null {
    return this.inference()?.model ?? null;
  }

  /** Pure decision bound to the exact category snapshot and inference model that produced it. The semantic
   * fingerprint prevents a deleted category whose numeric id is later reused from validating stale output.
   * `extraCategories` widens the option set (the shared pool of the current project) — the classifier may
   * file into it just like into a personal category; it still never invents one. */
  async classifyDecision(userId: number, body: string, extraCategories: MemoryCategoryRow[] = []): Promise<MemoryCategoryDecision> {
    const own = this.categories.list(userId);
    const known = new Set(own.map((c) => c.id));
    const cats = [...own, ...extraCategories.filter((c) => !known.has(c.id))];
    const inf = this.inference();
    if (cats.length === 0 || !inf) return { categoryId: null, categoryFingerprint: null, model: inf?.model ?? null };
    const { text } = await inf.decide(buildClassifyPrompt(body.slice(0, MAX_BODY_CHARS), cats));
    const categoryId = coerceCategory(text, cats);
    const category = categoryId === null ? null : cats.find((candidate) => candidate.id === categoryId) ?? null;
    return {
      categoryId,
      categoryFingerprint: category ? memoryCategoryFingerprint(category) : null,
      model: inf.model,
    };
  }

  /** Compatibility convenience for callers that only need the selected category id. */
  async classify(userId: number, body: string, extraCategories: MemoryCategoryRow[] = []): Promise<number | null> {
    return (await this.classifyDecision(userId, body, extraCategories)).categoryId;
  }

  /** Load one memory, classify it, and persist via memories.setCategory ONLY if the category id changed.
   *  Best-effort: swallows + logs every failure (fire-and-forget safe from the curator). Skips memories
   *  that aren't active. */
  async classifyMemory(userId: number, memoryId: number, actor: string): Promise<void> {
    try {
      const mem = this.memories.get(userId, memoryId);
      if (!mem || mem.status !== 'active') return;
      const revision = this.memories.revision(memoryId);
      const decision = await this.classifyDecision(userId, mem.body);
      this.memories.setCategoryIfUnchanged(
        userId,
        memoryId,
        {
          bodyHash: hashBody(mem.body),
          categoryId: mem.category_id,
          revision,
          targetCategoryFingerprint: decision.categoryFingerprint,
        },
        decision.categoryId,
        actor,
        'categorizer: auto-classified',
        decision.model,
      );
    } catch (err) {
      this.logger?.warn('memory categorizer failed', { userId, memoryId, error: String(err) });
    }
  }

  /** Fire-and-forget classification of a memory that was JUST stored. Every write path goes through this
   *  — the curator, the MemoryAdd tool and the API — so which path created a memory no longer decides
   *  whether it gets a category at all. Deliberately not awaited: storing a fact must not wait on a model
   *  round-trip. classifyMemory already swallows and logs its own failures; the catch only guarantees it
   *  can never reject into a caller that is not awaiting it. */
  classifyNewMemory(userId: number, memoryId: number, actor: string): void {
    void this.classifyMemory(userId, memoryId, actor).catch(() => { /* best-effort */ });
  }

  /** Batch (re)classify the user's active memories, capped at MAX_RECLASSIFY. By default only touches
   *  uncategorized rows (categoryId:null filter); `includeCategorized` re-tags everything. Rows sitting
   *  in a SHARED pool are always excluded — the pool belongs to the team, and a personal reclassify pass
   *  must never quietly pull another member's shared memories out of it (nor push private ones in). Each
   *  memory is best-effort — one failure is logged and skipped, never aborting the pass. Returns {
   *  scanned, classified } where `classified` counts rows that landed on a non-null category. */
  async reclassify(userId: number, opts?: { limit?: number; includeCategorized?: boolean }): Promise<{ scanned: number; classified: number }> {
    const inf = this.inference();
    if (!inf) return { scanned: 0, classified: 0 };
    if (this.categories.list(userId).length === 0) return { scanned: 0, classified: 0 };
    const limit = Math.min(opts?.limit ?? MAX_RECLASSIFY, MAX_RECLASSIFY);
    let rows = this.memories.list(userId, opts?.includeCategorized
      ? { status: 'active', limit }
      : { status: 'active', categoryId: null, limit });
    if (opts?.includeCategorized) {
      const poolIds = new Set(this.memories.sharedPoolCategoryIds());
      rows = rows.filter((m) => m.category_id === null || !poolIds.has(m.category_id));
    }
    let classified = 0;
    for (const m of rows) {
      try {
        const revision = this.memories.revision(m.id);
        const decision = await this.classifyDecision(userId, m.body);
        const written = this.memories.setCategoryIfUnchanged(
          userId,
          m.id,
          {
            bodyHash: hashBody(m.body),
            categoryId: m.category_id,
            revision,
            targetCategoryFingerprint: decision.categoryFingerprint,
          },
          decision.categoryId,
          `user:${userId}`,
          'categorizer: reclassified',
          decision.model,
        );
        if (written && decision.categoryId !== null) classified += 1;
      } catch (err) {
        this.logger?.warn('memory reclassify op failed', { userId, memoryId: m.id, error: String(err) });
      }
    }
    return { scanned: rows.length, classified };
  }

  /** Pick ONE lucide icon from ICON_ALLOWLIST that best fits a category name, using the categorizer model.
   *  Fail-soft: no model wired, a relay error, or an unrecognized reply all fall back to 'Folder'. Never
   *  throws — safe to call inline from the category-create route. */
  async suggestIcon(name: string): Promise<string> {
    const label = name.trim();
    if (label === '') return DEFAULT_ICON;
    const inf = this.inference();
    if (!inf) return DEFAULT_ICON;
    try {
      const { text } = await inf.decide(buildIconPrompt(label));
      return coerceIcon(text);
    } catch (err) {
      this.logger?.warn('memory icon suggest failed', { name: label, error: String(err) });
      return DEFAULT_ICON;
    }
  }
}

/** The icon prompt: strict single-token reply constrained to the allowlist, mirroring the classify tone. */
function buildIconPrompt(name: string): string {
  return [
    'Pick EXACTLY ONE icon from the allowed list below that best represents this memory category.',
    'Reply with ONLY the icon name (exactly as listed), no other text. Do not invent new names.',
    '',
    'Allowed icons:',
    ICON_ALLOWLIST.join(', '),
    '',
    `Category: ${name}`,
  ].join('\n');
}

/** Coerce the model's reply to a KNOWN allowlist icon (case-insensitive, tolerant of a fence/quotes),
 *  else 'Folder'. Prefers an exact name match, then a whole-token hit inside a longer reply. */
function coerceIcon(reply: string): string {
  const cleaned = reply
    .trim()
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/```$/, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
    .toLowerCase();
  if (cleaned === '') return DEFAULT_ICON;
  for (const icon of ICON_ALLOWLIST) {
    if (icon.toLowerCase() === cleaned) return icon;
  }
  for (const icon of ICON_ALLOWLIST) {
    if (containsWholeToken(cleaned, icon.toLowerCase())) return icon;
  }
  return DEFAULT_ICON;
}

/** The classify prompt: strict single-token reply, mirrors memoryCurator's tone. Lists every category as
 *  `- <name>: <description>` so the model classifies against the descriptions, and forbids inventing a
 *  new category. English prompt; the memory body itself stays in the user's own language. */
function buildClassifyPrompt(body: string, cats: MemoryCategoryRow[]): string {
  return [
    'You are the memory classifier for the assistant Elowen. Assign the memory below to EXACTLY ONE of the categories.',
    'Decide by each category\'s description. If none fits, reply with the word "none".',
    'Reply with ONLY the category name (exactly as listed), no other text. Do not invent new categories.',
    '',
    'Categories:',
    cats.map((c) => `- ${c.name}: ${c.description}`).join('\n'),
    '',
    `Memory: ${body}`,
  ].join('\n');
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
    if (containsWholeToken(cleaned, name)) return c.id;
  }
  return null;
}
