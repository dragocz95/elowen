import type { MemoryRow, MemoryStore, MemoryUsageContext } from '../store/memoryStore.js';
import type { EmbeddingConfig, EmbeddingService } from '../embeddings/embeddingService.js';
import { isEmbeddingConfigured } from '../embeddings/embeddingService.js';
import { parseDbTs } from '../shared/time.js';
import { currentMemoryRecallScope } from '../plugins/policyContext.js';
import type { MemoryCategoryStore } from '../store/memoryCategoryStore.js';
import { DEFAULT_MEMORY_RETENTION, USAGE_K, vitality } from './memoryVitality.js';
import type { MemoryRetentionConfig } from './memoryVitality.js';
import type { MemoryRecallScope } from './memoryRecallScope.js';

/** Weight of each signal in the combined retrieval score. Semantic similarity dominates; importance
 *  and vitality break ties. Sums to 1.0.
 *
 *  Vitality is deliberately a SMALL share. It is driven by `use_count`, which recall itself increments
 *  through markRecalled → markUsed, so any large weight here is a feedback loop: recalled memories become
 *  more recallable regardless of the query. Measured on the live store before this was cut from 0.20 to
 *  0.10 (90 active memories, 14 days): the top 5 memories took 31% of 272 recalls while 12 had never been
 *  recalled once. Keep the query-independent share (importance + vitality) at or below 0.20 — above that
 *  the ranking stops being about the question. */
const W_SEMANTIC = 0.8;
const W_IMPORTANCE = 0.1;
const W_VITALITY = 0.1;

/** Recency decay half-life (days): a memory this old contributes ~0.5 to recencyWeight. */
const RECENCY_HALF_LIFE_DAYS = 30;

/** Two retrieved results whose vectors cosine at or above this are treated as the same memory — the
 *  lower-ranked one is dropped so the set isn't padded with paraphrases of one fact.
 *
 *  CALIBRATED AGAINST THE REAL STORE, not guessed: over all 4005 pairs of the 90 embedded memories the
 *  distribution is p50 0.216, p90 0.383, p99 0.539, max 0.765. The previous 0.97 sat above every pair
 *  that exists, so this check never once fired. Everything at or above 0.65 is a same-category pair, and
 *  the two clear duplicate pairs (two write-ups of one prompt-cache incident; two of one recall rule)
 *  sit at 0.765 and 0.756. This is a per-embedding-model constant: after changing the embedding model,
 *  re-measure the pair distribution before trusting it. */
const DEDUPE_COSINE = 0.7;

/** Defaults for retrieve(). ~6 memories capped at ~1500 chars keeps the injected context tight. */
const DEFAULT_MAX_COUNT = 6;
const DEFAULT_CHAR_BUDGET = 1500;

/** Minimum semantic (cosine) similarity for a memory to count as RELEVANT to a query. Below this the
 *  memory is unrelated — dropping it stops a small memory store from injecting every fact into every
 *  prompt (and keeps the manual search box on-topic). Cosine-scale, tuned for the current embedding
 *  models: genuinely related pairs land well above (~0.5+), unrelated noise sits ~0.1–0.2. Only the raw
 *  `semantic` component is floored; importance and vitality still reorder whatever survives.
 *  The operator can retune it (Settings → Elowen AI → Runtime); this is the value when nothing is wired. */
const MIN_SEMANTIC = 0.3;

/** The operator's floor travels as an integer per mille (300 = 0.30) because every configurable limit is
 *  rounded to a whole number on save — a cosine float would round to 0 and floor nothing. */
const PER_MILLE = 1000;

/** Default for findSimilar(): the cosine at which two bodies count as near-duplicates for the curator
 *  and the MemoryAdd tool. Set well ABOVE {@link DEDUPE_COSINE} because the consequences differ — a false
 *  positive here makes the curator UPDATE one memory with another's content (data loss), whereas in
 *  packing it only drops a result.
 *
 *  RE-MEASURED 24 Aug 2026 (332 memories, 54946 pairs, qwen3-embedding-8b). The old 0.72 was read off a
 *  store whose largest pair was 0.765; the corpus has grown past that, and the two pairs it was calibrated
 *  on are no longer the top of the distribution. Hand-reading the highest pairs found no true restatement
 *  at any cosine the store reaches — the maximum, 0.911, is two distinct findings about one supplier — so
 *  on long technical notes in a consistent voice this measures shared TOPIC, not duplication. Length alone
 *  lifts it: pairs where both sides are merely long average 0.535 against 0.484 for short ones, with a p99
 *  of 0.774. The value is therefore a lower bound from observed distinct pairs and has no upper
 *  calibration, which is exactly why the MemoryAdd tool warns instead of refusing. Re-measure after an
 *  embedding-model change or substantial growth of the store. */
const DEFAULT_SIMILAR_THRESHOLD = 0.93;
const DEFAULT_SIMILAR_LIMIT = 5;

export interface RetrieveOpts {
  maxCount?: number;
  charBudget?: number;
  /** Strict UTF-8 budget for callers that add the results to a byte-bounded prompt frame. */
  byteBudget?: number;
  /** Explicit turn scope. This takes precedence over AsyncLocalStorage for detached recall work. */
  scope?: MemoryRecallScope;
}

/** Per-memory score breakdown for the retrieval-debugging UI. In the keyword-fallback path `semantic`
 *  is 0 and `score` is the fallback rank; `picked` marks the memories actually returned. */
interface RetrieveScore {
  id: number;
  score: number;
  semantic: number;
  importanceWeight: number;
  recencyWeight: number;
  usageWeight: number;
  picked: boolean;
}

/** Everything the debugging UI needs to explain a retrieval: the query, whether the vector path was
 *  used, the provider/model behind it, and the full ranked candidate breakdown. */
interface RetrieveDebug {
  query: string;
  fallback: boolean;
  provider: string | null;
  model: string | null;
  candidates: number;
  scores: RetrieveScore[];
}

export interface RetrieveResult {
  memories: MemoryRow[];
  debug: RetrieveDebug;
}

export interface FindSimilarOpts {
  threshold?: number;
  limit?: number;
  /** Shared pool category ids to scan in addition to the user's own memories. */
  sharedCategoryIds?: ReadonlySet<number>;
}

export interface SimilarMemory {
  memory: MemoryRow;
  similarity: number;
}

interface Candidate {
  memory: MemoryRow;
  vector: Float32Array | null;
  score: number;
  semantic: number;
  importanceWeight: number;
  recencyWeight: number;
  usageWeight: number;
}

/** Cosine similarity of two vectors. Returns 0 on a length mismatch or a zero-norm input, so a
 *  malformed/empty vector never yields a spurious score. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Vector retrieval + anti-duplication over MemoryStore. Pure orchestration: it embeds via
 *  EmbeddingService and scans/scores rows the store hands back, but makes no HTTP calls of its own and
 *  owns no persistence beyond {@link MemoryService.markRecalled}, which its callers invoke once they have
 *  actually delivered a memory to the model. When no embedding provider/model is
 *  configured — or an embed call throws — it degrades gracefully to the store's keyword + recency
 *  fallback; memory still works, just without semantic ranking.
 *
 *  SECURITY: every read/write is user-scoped through MemoryStore (user_id filtered). This service never
 *  crosses users; the caller is responsible for only ever invoking it with the genuine owner's id. */
export class MemoryService {
  private readonly store: MemoryStore;
  private readonly categories?: MemoryCategoryStore;
  private readonly embeddings: EmbeddingService;
  /** Returns the active embedding config, or null when embeddings are disabled. A config missing a
   *  model or both providerId and baseUrl is also treated as disabled (→ keyword fallback). */
  private readonly embeddingConfig: () => EmbeddingConfig | null;
  /** Operator-tuned recall size (count + char budget) used when a caller doesn't pass its own opts —
   *  the per-turn recall path. Absent → the built-in defaults. */
  private readonly recallDefaults?: () => { count: number; chars: number };
  /** Operator-tuned semantic relevance floor, in per mille of cosine similarity. Absent (or non-finite)
   *  → {@link MIN_SEMANTIC}. Read per call so a Settings change applies without a restart. */
  private readonly semanticFloorPerMille?: () => number;
  /** Operator-tuned share of the score that is NOT the query, in per mille; semantic takes the rest.
   *  Absent (or non-finite) → the built-in weights. Read per call, like the floor above. */
  private readonly scoreWeightsPerMille?: () => { importance: number; vitality: number };
  /** Operator-tuned cosine thresholds, in per mille: `duplicate` decides when a new body updates an
   *  existing memory instead of adding one, `paraphrase` when a recalled memory is redundant with one
   *  already picked. Absent (or non-finite) → the built-in constants. */
  private readonly dedupePerMille?: () => { duplicate: number; paraphrase: number };
  /** Active memory-retention policy. Absent → the built-in vitality defaults. */
  private readonly retention?: () => MemoryRetentionConfig;
  /** Nudged after a delivered recall so live views can refresh. Absent → nobody is listening. */
  private readonly onRecalled?: (userId: number) => void;
  /** Shared pool category ids the user may touch across every project they share. Injected by the
   *  bootstrap so the browsing surfaces (web list, semantic search, retrieval inspector) can widen
   *  their candidate queries past the user_id filter; turn recall gets its shared set from the scope
   *  instead. Absent → no shared pools are considered. */
  private readonly sharedCategoriesOf?: (userId: number) => number[];

  constructor(deps: {
    store: MemoryStore;
    categories?: MemoryCategoryStore;
    embeddings: EmbeddingService;
    embeddingConfig: () => EmbeddingConfig | null;
    recallDefaults?: () => { count: number; chars: number };
    semanticFloorPerMille?: () => number;
    scoreWeightsPerMille?: () => { importance: number; vitality: number };
    dedupePerMille?: () => { duplicate: number; paraphrase: number };
    retention?: () => MemoryRetentionConfig;
    /** Called after a delivered recall bumped the counters, so live views can refresh themselves. A
     *  recall changes memory state without any user action, and nothing else would tell the UI. */
    onRecalled?: (userId: number) => void;
    sharedCategoriesOf?: (userId: number) => number[];
  }) {
    this.store = deps.store;
    this.categories = deps.categories;
    this.embeddings = deps.embeddings;
    this.embeddingConfig = deps.embeddingConfig;
    this.recallDefaults = deps.recallDefaults;
    this.semanticFloorPerMille = deps.semanticFloorPerMille;
    this.scoreWeightsPerMille = deps.scoreWeightsPerMille;
    this.dedupePerMille = deps.dedupePerMille;
    this.retention = deps.retention;
    this.onRecalled = deps.onRecalled;
    this.sharedCategoriesOf = deps.sharedCategoriesOf;
  }

  /** The relevance floor on the cosine scale the scorers work in. */
  private minSemantic(): number {
    const configured = this.semanticFloorPerMille?.();
    return typeof configured === 'number' && Number.isFinite(configured) ? configured / PER_MILLE : MIN_SEMANTIC;
  }

  /** The three score weights on the 0–1 scale, always summing to 1. Only importance and vitality are
   *  configured; semantic takes the remainder, so the operator cannot produce a set that sums to
   *  something else. A non-finite or out-of-range pair falls back to the built-in weights whole rather
   *  than mixing one configured value with two defaults, which would silently break that sum. */
  private weights(): { semantic: number; importance: number; vitality: number } {
    const configured = this.scoreWeightsPerMille?.();
    const importance = configured?.importance;
    const vitality = configured?.vitality;
    const usable = typeof importance === 'number' && Number.isFinite(importance) && importance >= 0
      && typeof vitality === 'number' && Number.isFinite(vitality) && vitality >= 0
      && importance + vitality <= PER_MILLE;
    if (!usable) return { semantic: W_SEMANTIC, importance: W_IMPORTANCE, vitality: W_VITALITY };
    return {
      semantic: (PER_MILLE - importance - vitality) / PER_MILLE,
      importance: importance / PER_MILLE,
      vitality: vitality / PER_MILLE,
    };
  }

  /** A configured cosine threshold on the 0–1 scale, or the built-in constant when unset/non-finite. */
  private threshold(which: 'duplicate' | 'paraphrase', fallback: number): number {
    const configured = this.dedupePerMille?.()[which];
    return typeof configured === 'number' && Number.isFinite(configured) ? configured / PER_MILLE : fallback;
  }

  /** Current vitality for a memory under the active retention policy. */
  vitalityOf(memory: MemoryRow): number {
    return vitality(memory, this.retention?.() ?? DEFAULT_MEMORY_RETENTION, Date.now());
  }

  /** Retrieve the most relevant memories for `queryText`. Vector path: embed the query, cosine-score
   *  every active memory that has an embedding, blend in importance/vitality, sort, dedupe near-identical
   *  hits, and pack the top ones within maxCount + charBudget. Fallback path (no config or embed throws):
   *  keyword hits merged with recent memories, ranked by keyword match + importance + recency. Actual
   *  recall marks the returned set as used; inspection can opt out and still receives full debug scores. */
  async retrieve(userId: number, queryText: string, opts: RetrieveOpts = {}): Promise<RetrieveResult> {
    const query = queryText.trim();
    const tuned = this.recallDefaults?.();
    const maxCount = opts.maxCount ?? tuned?.count ?? DEFAULT_MAX_COUNT;
    const charBudget = opts.charBudget ?? tuned?.chars ?? DEFAULT_CHAR_BUDGET;
    const byteBudget = opts.byteBudget;
    const scope = this.recallScope(userId, opts.scope);
    const cfg = this.activeConfig();
    const provider = cfg ? (cfg.providerId ?? cfg.baseUrl ?? null) : null;
    const model = cfg?.model ?? null;

    if (query === '') {
      return { memories: [], debug: { query, fallback: cfg === null, provider, model, candidates: 0, scores: [] } };
    }

    if (cfg) {
      try {
        const queryVec = await this.embeddings.embed(cfg, query);
        const semantic = this.retrieveVector(userId, query, queryVec, maxCount, charBudget, byteBudget, provider, model, scope);
        // An embed that succeeds but clears nothing is not "no memory is relevant" — it is usually a
        // query too thin to score, like "fix it", which cannot reach the floor against any body no
        // matter how on-topic. Measured: that query peaks at 0.12 cosine and admits 0 of 53 memories.
        // The manual search box has fallen through to keyword for exactly this reason (searchSemantic);
        // recall silently returned nothing instead, which is where the "it forgot again" reports come from.
        if (semantic.memories.length > 0) return semantic;
        const keyword = this.retrieveFallback(userId, query, maxCount, charBudget, byteBudget, provider, model, scope, true);
        // Keep the cosine breakdown from the pass that found nothing. Otherwise the debug panel reports
        // a bare "fallback" and cannot answer the only question worth asking here — how close the best
        // candidate actually came to the floor.
        return { memories: keyword.memories, debug: { ...keyword.debug, scores: semantic.debug.scores, candidates: semantic.debug.candidates } };
      } catch {
        // Embed failed (endpoint down, malformed response, …) → degrade to keyword fallback rather
        // than surfacing an error into the chat path. Memory retrieval is best-effort.
      }
    }

    return this.retrieveFallback(userId, query, maxCount, charBudget, byteBudget, provider, model, scope, false);
  }

  /** Record that these memories were actually DELIVERED to the model.
   *
   *  Retrieval deliberately does not do this itself. It used to, and the counter therefore measured
   *  retrieval passes rather than deliveries: live recall runs several passes per turn and drops the
   *  memories it has already injected, so a memory matching twice was counted twice while reaching the
   *  prompt once (measured 2026-08-03: 156 of 441 marks, 35%, were such phantoms). Inflated use_count
   *  feeds straight into vitality, which decides what the retention sweep evicts — so the caller that
   *  knows what it actually handed over is the only one that can mark honestly. */
  markRecalled(userId: number, ids: number[], context?: MemoryUsageContext): void {
    if (ids.length === 0) return;
    this.store.markUsed(userId, ids, context);
    this.onRecalled?.(userId);
  }

  /** Find active memories whose body is a near-duplicate of `body` (cosine ≥ threshold), sorted most
   *  similar first. Powers the curator + MemoryAdd tool's "prefer update over near-duplicate". When
   *  embeddings are not configured — or the embed throws — this degrades to an empty result, i.e. "no
   *  near-duplicate detected", so the caller simply falls back to inserting a fresh memory.
   *  `sharedCategoryIds` widens the scan over a shared pool, so a member's add reports a neighbour
   *  another member already stored instead of silently duplicating it. */
  async findSimilar(userId: number, body: string, opts: FindSimilarOpts = {}): Promise<SimilarMemory[]> {
    const text = body.trim();
    if (text === '') return [];
    const cfg = this.activeConfig();
    if (!cfg) return [];
    const threshold = opts.threshold ?? this.threshold('duplicate', DEFAULT_SIMILAR_THRESHOLD);
    const limit = opts.limit ?? DEFAULT_SIMILAR_LIMIT;
    const shared = opts.sharedCategoryIds ? [...opts.sharedCategoryIds] : [];

    let vec: Float32Array;
    try {
      vec = await this.embeddings.embed(cfg, text);
    } catch {
      return [];
    }

    return this.store.listActiveWithEmbeddings(userId, shared)
      .map((row) => ({ memory: row.memory, similarity: cosine(vec, row.vector) }))
      .filter((r) => r.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /** Return only recallable recent memories. The category predicate is applied in SQLite before LIMIT,
   * so excluded rows cannot hide eligible results later in the list. */
  listRecent(userId: number, limit: number, opts: Pick<RetrieveOpts, 'scope'> = {}): MemoryRow[] {
    const scope = this.recallScope(userId, opts.scope);
    if (!scope) return [];
    return this.store.listRecentInCategories(userId, scope.categoryIds, limit, [...scope.sharedCategoryIds]);
  }

  /** Semantic search for the manual memory browser (Settings → Memory search box): embed the query and
   *  return the caller's active memories ranked by cosine (most similar first), keeping only those above
   *  the relevance floor. Browsing isn't recall, so nothing here is ever marked as used, and it returns
   *  raw rows for the list UI. Shared pools the user belongs to are searched alongside their own rows —
   *  the browser shows the team memory too. Degrades to the store's keyword LIKE search when embeddings
   *  aren't configured or the embed call throws, so the search box always returns something. */
  async searchSemantic(userId: number, query: string, limit: number): Promise<MemoryRow[]> {
    const q = query.trim();
    if (q === '') return [];
    const shared = this.sharedCategoriesOf?.(userId) ?? [];
    const cfg = this.activeConfig();
    if (cfg) {
      try {
        const floor = this.minSemantic();
        const queryVec = await this.embeddings.embed(cfg, q);
        const hits = this.store.listActiveWithEmbeddings(userId, shared)
          .map(({ memory, vector }) => ({ memory, similarity: cosine(queryVec, vector) }))
          .filter((r) => r.similarity >= floor)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, limit)
          .map((r) => r.memory);
        // Semantic found something on-topic → use it. When it comes back empty (nothing cleared the
        // floor, or the matching memories aren't embedded yet) fall through to keyword so an exact-word
        // search still finds a memory that exists.
        if (hits.length > 0) return hits;
      } catch { /* embed failed → keyword fallback below */ }
    }
    return this.store.search(userId, q, limit, shared);
  }

  /** Vector path: score every embedded memory, sort, dedupe, pack, optionally mark as used. */
  private retrieveVector(
    userId: number,
    query: string,
    queryVec: Float32Array,
    maxCount: number,
    charBudget: number,
    byteBudget: number | undefined,
    provider: string | null,
    model: string | null,
    scope: MemoryRecallScope | undefined,
  ): RetrieveResult {
    const now = Date.now();
    const retention = this.retention?.() ?? DEFAULT_MEMORY_RETENTION;
    const w = this.weights();
    const ranked: Candidate[] = this.recallable(
      this.store.listActiveWithEmbeddings(userId, scope ? [...scope.sharedCategoryIds] : []),
      ({ memory }) => memory, scope,
    )
      .map(({ memory, vector }) => {
        const semantic = cosine(queryVec, vector);
        const importanceWeight = importanceWeightOf(memory);
        const recencyWeight = recencyWeightOf(memory, now);
        const usageWeight = usageWeightOf(memory);
        const score = semantic * w.semantic + importanceWeight * w.importance
          + (vitality(memory, retention, now) / 100) * w.vitality;
        return { memory, vector, score, semantic, importanceWeight, recencyWeight, usageWeight };
      })
      .sort((a, b) => b.score - a.score);

    // Only memories actually related to the query are eligible for injection — an unrelated memory must
    // not ride recency/importance into the prompt. `ranked` stays whole so the debug UI still explains
    // every candidate (including the ones floored out).
    const eligible = ranked.filter((c) => c.semantic >= this.minSemantic());
    const picked = this.pack(eligible, maxCount, charBudget, byteBudget, true);
    return {
      memories: picked.map((c) => c.memory),
      debug: { query, fallback: false, provider, model, candidates: ranked.length, scores: toScores(ranked, picked) },
    };
  }

  /** Keyword fallback: merge keyword hits with recent memories, rank by keyword match + importance +
   *  recency (no vectors available), dedupe by exact body and pack. */
  private retrieveFallback(
    userId: number,
    query: string,
    maxCount: number,
    charBudget: number,
    byteBudget: number | undefined,
    provider: string | null,
    model: string | null,
    scope: MemoryRecallScope | undefined,
    keywordOnly = false,
  ): RetrieveResult {
    const now = Date.now();
    const sharedIds = scope ? [...scope.sharedCategoryIds] : [];
    const keywordHits = this.recallable(this.store.search(userId, query, maxCount * 3, sharedIds), (memory) => memory, scope);
    const keywordIds = new Set(keywordHits.map((m) => m.id));
    // Recency is a sane last resort while we have NO relevance signal at all — embeddings unconfigured,
    // or the endpoint down. It is the wrong answer after a vector pass that simply cleared nothing:
    // there the cosine scores already established these memories are off-topic, so padding the result
    // with whatever was written most recently would inject unrelated facts — exactly what the floor is
    // there to prevent.
    const recent = keywordOnly ? [] : this.recallable(this.store.listRecent(userId, maxCount * 3, sharedIds), (memory) => memory, scope);

    const byId = new Map<number, MemoryRow>();
    for (const m of [...keywordHits, ...recent]) byId.set(m.id, m);

    const ranked: Candidate[] = [...byId.values()]
      .map((memory) => {
        const semantic = 0;
        const importanceWeight = importanceWeightOf(memory);
        const recencyWeight = recencyWeightOf(memory, now);
        const usageWeight = usageWeightOf(memory);
        // Keyword match is the strongest fallback signal; importance/recency break ties.
        const keywordMatch = keywordIds.has(memory.id) ? 1 : 0;
        const score = keywordMatch * 0.6 + importanceWeight * 0.25 + recencyWeight * 0.15;
        return { memory, vector: null, score, semantic, importanceWeight, recencyWeight, usageWeight };
      })
      .sort((a, b) => b.score - a.score);

    const picked = this.pack(ranked, maxCount, charBudget, byteBudget, false);
    return {
      memories: picked.map((c) => c.memory),
      debug: { query, fallback: true, provider, model, candidates: ranked.length, scores: toScores(ranked, picked) },
    };
  }

  /** Greedily take from the pre-sorted candidates: at most maxCount, staying within charBudget (the
   *  top candidate is always admitted even if it alone exceeds the character budget). A byte-bounded
   *  caller instead receives only candidates that fit its strict UTF-8 budget. When `dedupe`, a candidate
   *  whose vector is near-identical (cosine ≥ DEDUPE_COSINE) to an already-picked one is skipped;
   *  otherwise dedupe falls back to exact-body equality. */
  private pack(
    ranked: Candidate[], maxCount: number, charBudget: number, byteBudget: number | undefined, dedupe: boolean,
  ): Candidate[] {
    const picked: Candidate[] = [];
    const paraphrase = this.threshold('paraphrase', DEDUPE_COSINE);
    let chars = 0;
    let bytes = 0;
    for (const cand of ranked) {
      if (picked.length >= maxCount) break;
      const isDup = dedupe && cand.vector
        ? picked.some((p) => p.vector && cosine(p.vector, cand.vector!) >= paraphrase)
        : picked.some((p) => p.memory.body === cand.memory.body);
      if (isDup) continue;
      const charLength = cand.memory.body.length;
      const byteLength = Buffer.byteLength(cand.memory.body);
      if (byteBudget === undefined) {
        if (picked.length > 0 && chars + charLength > charBudget) continue;
      } else if (bytes + byteLength > byteBudget) {
        continue;
      }
      picked.push(cand);
      chars += charLength;
      bytes += byteLength;
    }
    return picked;
  }

  /** Recall never considers uncategorized memories. An explicit scope gates vector, keyword and recency
   * candidates before any scorer can rank them; AsyncLocalStorage is only the legacy fallback. */
  private recallable<T>(rows: T[], memoryOf: (row: T) => MemoryRow, scope: MemoryRecallScope | undefined): T[] {
    if (!scope) return [];
    return rows.filter((row) => {
      const memory = memoryOf(row);
      return memory.category_id !== null && scope.categoryIds.has(memory.category_id);
    });
  }

  private recallScope(userId: number, explicitScope?: MemoryRecallScope): MemoryRecallScope | undefined {
    return explicitScope ?? currentMemoryRecallScope() ?? this.globalScope(userId);
  }

  private globalScope(userId: number): MemoryRecallScope | undefined {
    if (!this.categories) return undefined;
    return {
      projectId: null,
      categoryIds: new Set(this.categories.list(userId)
        .filter((category) => category.projectId === null)
        .map((category) => category.id)),
      // A global scope (channels, detached work) never carries a shared pool: shared categories are
      // project-bound and only ever recall inside their project.
      sharedCategoryIds: new Set<number>(),
    };
  }

  /** Every category the caller owns plus every shared pool they belong to, ignoring project boundaries.
   *  The retrieval-debugging inspector uses this: it runs from a web request with no turn/project
   *  context, so scoping it like a real recall would collapse to globals and hide the caller's project
   *  memories. Uncategorized are still excluded, since recall never surfaces them. The shared side is
   *  already narrowed to pools the CALLER belongs to (the injected resolver answers only those) — it is
   *  an INSPECTION scope only, never a recall path, and never widens to someone else's pool. */
  allCategoriesScope(userId: number): MemoryRecallScope | undefined {
    if (!this.categories) return undefined;
    const shared = this.sharedCategoriesOf?.(userId) ?? [];
    return {
      projectId: null,
      categoryIds: new Set([
        ...this.categories.list(userId).map((category) => category.id),
        ...shared,
      ]),
      sharedCategoryIds: new Set(shared),
    };
  }

  /** The active embedding config, or null when embeddings are disabled (no config, empty model, or
   *  neither providerId nor baseUrl to reach an endpoint). */
  private activeConfig(): EmbeddingConfig | null {
    const cfg = this.embeddingConfig();
    return isEmbeddingConfigured(cfg) ? cfg : null;
  }
}

/** Importance 1..5 → 0..1 linear. */
function importanceWeightOf(m: MemoryRow): number {
  const clamped = Math.min(5, Math.max(1, m.importance));
  return (clamped - 1) / 4;
}

/** Exponential recency decay from updated_at (fallback created_at): 1 for "just now", halving every
 *  RECENCY_HALF_LIFE_DAYS. An unparseable or future timestamp yields 1 (treated as fresh). */
function recencyWeightOf(m: MemoryRow, now: number): number {
  const ts = parseTs(m.updated_at) ?? parseTs(m.created_at);
  if (ts === null) return 1;
  const ageDays = Math.max(0, (now - ts) / 86_400_000);
  return Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS);
}

/** use_count → 0..1, saturating: 0 → 0, USAGE_K → 0.5, →1 as it grows. */
function usageWeightOf(m: MemoryRow): number {
  const n = Math.max(0, m.use_count);
  return n / (n + USAGE_K);
}

/** Parse a SQLite 'YYYY-MM-DD HH:MM:SS' UTC timestamp to epoch millis, or null if unparseable. Delegates
 *  to the shared DB-timestamp parser; 0 (empty/unparseable) maps back to null for the `??` fallback below. */
function parseTs(s: string | null): number | null {
  return parseDbTs(s) || null;
}

/** Project ranked candidates to the debug score shape, flagging which were picked. */
function toScores(ranked: Candidate[], picked: Candidate[]): RetrieveScore[] {
  const pickedIds = new Set(picked.map((c) => c.memory.id));
  return ranked.map((c) => ({
    id: c.memory.id,
    score: c.score,
    semantic: c.semantic,
    importanceWeight: c.importanceWeight,
    recencyWeight: c.recencyWeight,
    usageWeight: c.usageWeight,
    picked: pickedIds.has(c.memory.id),
  }));
}
