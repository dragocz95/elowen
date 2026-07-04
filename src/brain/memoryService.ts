import type { MemoryRow, MemoryStore } from '../store/memoryStore.js';
import type { EmbeddingConfig, EmbeddingService } from '../embeddings/embeddingService.js';
import { isEmbeddingConfigured } from '../embeddings/embeddingService.js';

/** Weight of each signal in the combined retrieval score. Semantic similarity dominates; importance,
 *  recency and usage nudge ties. Sums to 1.0. */
const W_SEMANTIC = 0.65;
const W_IMPORTANCE = 0.15;
const W_RECENCY = 0.1;
const W_USAGE = 0.1;

/** Recency decay half-life (days): a memory this old contributes ~0.5 to recencyWeight. */
const RECENCY_HALF_LIFE_DAYS = 30;
/** Usage saturation constant: use_count === USAGE_K maps to a usageWeight of 0.5. */
const USAGE_K = 5;

/** Two retrieved results whose vectors cosine at or above this are treated as the same memory — the
 *  lower-ranked one is dropped so the set isn't padded with paraphrases of one fact. */
const DEDUPE_COSINE = 0.97;

/** Defaults for retrieve(). ~6 memories capped at ~1500 chars keeps the injected context tight. */
const DEFAULT_MAX_COUNT = 6;
const DEFAULT_CHAR_BUDGET = 1500;

/** Minimum semantic (cosine) similarity for a memory to count as RELEVANT to a query. Below this the
 *  memory is unrelated — dropping it stops a small memory store from injecting every fact into every
 *  prompt (and keeps the manual search box on-topic). Cosine-scale, tuned for the current embedding
 *  models: genuinely related pairs land well above (~0.5+), unrelated noise sits ~0.1–0.2. Only the raw
 *  `semantic` component is floored; importance/recency/usage still reorder whatever survives. */
const MIN_SEMANTIC = 0.3;

/** Defaults for findSimilar(): at 0.85 cosine two bodies are near-duplicates for the curator/tool. */
const DEFAULT_SIMILAR_THRESHOLD = 0.85;
const DEFAULT_SIMILAR_LIMIT = 5;

export interface RetrieveOpts {
  maxCount?: number;
  charBudget?: number;
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
 *  owns no persistence beyond calling markUsed on the returned set. When no embedding provider/model is
 *  configured — or an embed call throws — it degrades gracefully to the store's keyword + recency
 *  fallback; memory still works, just without semantic ranking.
 *
 *  SECURITY: every read/write is user-scoped through MemoryStore (user_id filtered). This service never
 *  crosses users; the caller is responsible for only ever invoking it with the genuine owner's id. */
export class MemoryService {
  private readonly store: MemoryStore;
  private readonly embeddings: EmbeddingService;
  /** Returns the active embedding config, or null when embeddings are disabled. A config missing a
   *  model or both providerId and baseUrl is also treated as disabled (→ keyword fallback). */
  private readonly embeddingConfig: () => EmbeddingConfig | null;

  constructor(deps: {
    store: MemoryStore;
    embeddings: EmbeddingService;
    embeddingConfig: () => EmbeddingConfig | null;
  }) {
    this.store = deps.store;
    this.embeddings = deps.embeddings;
    this.embeddingConfig = deps.embeddingConfig;
  }

  /** Retrieve the most relevant memories for `queryText`. Vector path: embed the query, cosine-score
   *  every active memory that has an embedding, blend in importance/recency/usage, sort, dedupe
   *  near-identical hits, and pack the top ones within maxCount + charBudget. Fallback path (no config
   *  or embed throws): keyword hits merged with recent memories, ranked by keyword match + importance +
   *  recency. Either way the returned set is markUsed'd and a full debug breakdown is returned. */
  async retrieve(userId: number, queryText: string, opts: RetrieveOpts = {}): Promise<RetrieveResult> {
    const query = queryText.trim();
    const maxCount = opts.maxCount ?? DEFAULT_MAX_COUNT;
    const charBudget = opts.charBudget ?? DEFAULT_CHAR_BUDGET;
    const cfg = this.activeConfig();
    const provider = cfg ? (cfg.providerId ?? cfg.baseUrl ?? null) : null;
    const model = cfg?.model ?? null;

    if (query === '') {
      return { memories: [], debug: { query, fallback: cfg === null, provider, model, candidates: 0, scores: [] } };
    }

    if (cfg) {
      try {
        const queryVec = await this.embeddings.embed(cfg, query);
        return this.retrieveVector(userId, query, queryVec, maxCount, charBudget, provider, model);
      } catch {
        // Embed failed (endpoint down, malformed response, …) → degrade to keyword fallback rather
        // than surfacing an error into the chat path. Memory retrieval is best-effort.
      }
    }

    return this.retrieveFallback(userId, query, maxCount, charBudget, provider, model);
  }

  /** Find active memories whose body is a near-duplicate of `body` (cosine ≥ threshold), sorted most
   *  similar first. Powers the curator + memory_add tool's "prefer update over near-duplicate". When
   *  embeddings are not configured — or the embed throws — this degrades to an empty result, i.e. "no
   *  near-duplicate detected", so the caller simply falls back to inserting a fresh memory. */
  async findSimilar(userId: number, body: string, opts: FindSimilarOpts = {}): Promise<SimilarMemory[]> {
    const text = body.trim();
    if (text === '') return [];
    const cfg = this.activeConfig();
    if (!cfg) return [];
    const threshold = opts.threshold ?? DEFAULT_SIMILAR_THRESHOLD;
    const limit = opts.limit ?? DEFAULT_SIMILAR_LIMIT;

    let vec: Float32Array;
    try {
      vec = await this.embeddings.embed(cfg, text);
    } catch {
      return [];
    }

    return this.store.listActiveWithEmbeddings(userId)
      .map((row) => ({ memory: row.memory, similarity: cosine(vec, row.vector) }))
      .filter((r) => r.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /** Semantic search for the manual memory browser (Settings → Memory search box): embed the query and
   *  return the caller's active memories ranked by cosine (most similar first), keeping only those above
   *  the relevance floor. Unlike retrieve() this does NOT markUsed — browsing isn't recall — and returns
   *  raw rows for the list UI. Degrades to the store's keyword LIKE search when embeddings aren't
   *  configured or the embed call throws, so the search box always returns something. */
  async searchSemantic(userId: number, query: string, limit: number): Promise<MemoryRow[]> {
    const q = query.trim();
    if (q === '') return [];
    const cfg = this.activeConfig();
    if (cfg) {
      try {
        const queryVec = await this.embeddings.embed(cfg, q);
        const hits = this.store.listActiveWithEmbeddings(userId)
          .map(({ memory, vector }) => ({ memory, similarity: cosine(queryVec, vector) }))
          .filter((r) => r.similarity >= MIN_SEMANTIC)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, limit)
          .map((r) => r.memory);
        // Semantic found something on-topic → use it. When it comes back empty (nothing cleared the
        // floor, or the matching memories aren't embedded yet) fall through to keyword so an exact-word
        // search still finds a memory that exists.
        if (hits.length > 0) return hits;
      } catch { /* embed failed → keyword fallback below */ }
    }
    return this.store.search(userId, q, limit);
  }

  /** Vector path: score every embedded memory, sort, dedupe, pack, markUsed. */
  private retrieveVector(
    userId: number,
    query: string,
    queryVec: Float32Array,
    maxCount: number,
    charBudget: number,
    provider: string | null,
    model: string | null,
  ): RetrieveResult {
    const now = Date.now();
    const ranked: Candidate[] = this.store.listActiveWithEmbeddings(userId)
      .map(({ memory, vector }) => {
        const semantic = cosine(queryVec, vector);
        const importanceWeight = importanceWeightOf(memory);
        const recencyWeight = recencyWeightOf(memory, now);
        const usageWeight = usageWeightOf(memory);
        const score = semantic * W_SEMANTIC + importanceWeight * W_IMPORTANCE
          + recencyWeight * W_RECENCY + usageWeight * W_USAGE;
        return { memory, vector, score, semantic, importanceWeight, recencyWeight, usageWeight };
      })
      .sort((a, b) => b.score - a.score);

    // Only memories actually related to the query are eligible for injection — an unrelated memory must
    // not ride recency/importance into the prompt. `ranked` stays whole so the debug UI still explains
    // every candidate (including the ones floored out).
    const eligible = ranked.filter((c) => c.semantic >= MIN_SEMANTIC);
    const picked = this.pack(eligible, maxCount, charBudget, true);
    this.store.markUsed(userId, picked.map((c) => c.memory.id));
    return {
      memories: picked.map((c) => c.memory),
      debug: { query, fallback: false, provider, model, candidates: ranked.length, scores: toScores(ranked, picked) },
    };
  }

  /** Keyword fallback: merge keyword hits with recent memories, rank by keyword match + importance +
   *  recency (no vectors available), dedupe by exact body, pack, markUsed. */
  private retrieveFallback(
    userId: number,
    query: string,
    maxCount: number,
    charBudget: number,
    provider: string | null,
    model: string | null,
  ): RetrieveResult {
    const now = Date.now();
    const keywordHits = this.store.search(userId, query, maxCount * 3);
    const keywordIds = new Set(keywordHits.map((m) => m.id));
    // Pull recent memories so a query with no keyword hit still surfaces something sensible.
    const recent = this.store.listRecent(userId, maxCount * 3);

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

    const picked = this.pack(ranked, maxCount, charBudget, false);
    this.store.markUsed(userId, picked.map((c) => c.memory.id));
    return {
      memories: picked.map((c) => c.memory),
      debug: { query, fallback: true, provider, model, candidates: ranked.length, scores: toScores(ranked, picked) },
    };
  }

  /** Greedily take from the pre-sorted candidates: at most maxCount, staying within charBudget (the
   *  top candidate is always admitted even if it alone exceeds the budget). When `dedupe`, a candidate
   *  whose vector is near-identical (cosine ≥ DEDUPE_COSINE) to an already-picked one is skipped;
   *  otherwise dedupe falls back to exact-body equality. */
  private pack(ranked: Candidate[], maxCount: number, charBudget: number, dedupe: boolean): Candidate[] {
    const picked: Candidate[] = [];
    let chars = 0;
    for (const cand of ranked) {
      if (picked.length >= maxCount) break;
      const isDup = dedupe && cand.vector
        ? picked.some((p) => p.vector && cosine(p.vector, cand.vector!) >= DEDUPE_COSINE)
        : picked.some((p) => p.memory.body === cand.memory.body);
      if (isDup) continue;
      const len = cand.memory.body.length;
      if (picked.length > 0 && chars + len > charBudget) continue;
      picked.push(cand);
      chars += len;
    }
    return picked;
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

/** Parse a SQLite 'YYYY-MM-DD HH:MM:SS' UTC timestamp to epoch millis, or null if unparseable. */
function parseTs(s: string | null): number | null {
  if (!s) return null;
  const ms = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
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
