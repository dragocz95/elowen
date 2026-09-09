import { isEmbeddingConfigured } from '../../embeddings/embeddingService.js';
import type { EmbeddingConfig, EmbeddingService } from '../../embeddings/embeddingService.js';
import { cosine } from '../memoryService.js';
import { logger } from '../../shared/logger.js';

const log = logger('tool-search-semantic');

/** One rankable document: the caller's stable id and the text the vector stands for. */
export interface SemanticDocument {
  id: string;
  text: string;
}

/** The durable vector-cache half. Structurally the daemon's `SearchVectorStore` (key:
 *  sha256(model\0text)), typed as a shape so tests can inject a plain map. */
export interface SemanticVectorCache {
  get(model: string, texts: readonly string[]): Map<string, Float32Array>;
  put(model: string, entries: readonly { text: string; vector: Float32Array }[]): void;
}

export interface ToolSemanticIndexDeps {
  /** The shared embedder; `embedBatch(cfg, texts, signal)` must honor the caller's abort. */
  embeddings: Pick<EmbeddingService, 'embedBatch'>;
  /** Live Settings → Memory embedding config, read per search so a change applies immediately. */
  embeddingConfig: () => EmbeddingConfig | null | undefined;
  /** Vector cache for tool/skill description vectors. Absent → embed every time (tests). The QUERY is
   *  deliberately never written here: queries are unbounded in cardinality and the store prunes FIFO,
   *  so caching them would evict the small, long-lived document vector set. */
  cache?: SemanticVectorCache;
  /** Test seam for the per-search timeout; production uses {@link SEMANTIC_SEARCH_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Hard per-search budget for the semantic half of ToolSearch: the tool answers on the turn path, so a
 *  slow embeddings endpoint must degrade to keyword ranking long before the model round-trip notices. */
export const SEMANTIC_SEARCH_TIMEOUT_MS = 1_500;

/** Below this cosine a document is about something else than the query — padding results with unrelated
 *  tools is worse than answering with keyword hits alone. The SAME floor as site-search ranking and
 *  memory recall: it answers the identical question against the same operator-configured model. */
const MIN_SEMANTIC_SCORE = 0.3;

/** How long one embeddings failure keeps the ranker off the network. `warnOnce` quiets the LOG, not the
 *  ATTEMPTS: without this, a dead endpoint costs the full timeout budget on every ToolSearch call for
 *  as long as the process lives. The breaker is closed again by the next call after the cooldown. */
const BREAKER_COOLDOWN_MS = 60_000;

/** Longest document text embedded verbatim. Tool descriptions are capped well below this by the prompt
 *  pipeline; the clamp only bounds a hostile/outlier schema so one batch stays one batch. */
const MAX_DOC_CHARS = 1_000;

/** Cosine-ranks documents against a query, backed by the shared EmbeddingService and the durable
 *  `search_vectors` cache — DOCUMENTS only. The query is never written to the cache: queries are
 *  unbounded in cardinality and the cache prunes FIFO by insertion age, so a stream of fresh searches
 *  would evict exactly the small, long-lived tool/skill vector set, and every ToolSearch would re-embed
 *  the whole surface inside one 1500 ms budget. Instead the query rides the per-call batch, which is
 *  otherwise only the documents not cached yet: the steady state is a single one-item batch per
 *  distinct query against cached documents. Any failure (no embedding model configured, timeout,
 *  endpoint error) returns an EMPTY map, which the caller reads as "rank by keywords": the tool
 *  degrades, never breaks. At most one WARN per boot, whichever condition trips it first. */
export class ToolSemanticIndex {
  private readonly embeddings: ToolSemanticIndexDeps['embeddings'];
  private readonly embeddingConfig: ToolSemanticIndexDeps['embeddingConfig'];
  private readonly cache?: SemanticVectorCache;
  private readonly timeoutMs: number;
  private warnedUnavailable = false;
  /** Epoch ms until which the endpoint is assumed down; 0 = closed. Set on any ranking failure. */
  private breakerOpenUntil = 0;

  constructor(deps: ToolSemanticIndexDeps) {
    this.embeddings = deps.embeddings;
    this.embeddingConfig = deps.embeddingConfig;
    this.cache = deps.cache;
    this.timeoutMs = deps.timeoutMs ?? SEMANTIC_SEARCH_TIMEOUT_MS;
  }

  /** Scores for the documents related to `query`, strongest last implied by the value. Ids without a
   *  score were not related enough to matter. Never throws. */
  async rank(query: string, docs: readonly SemanticDocument[]): Promise<Map<string, number>> {
    const scores = new Map<string, number>();
    if (docs.length === 0) return scores;
    const cfg = this.embeddingConfig() ?? null;
    if (!isEmbeddingConfigured(cfg)) {
      this.warnOnce(`semantic ToolSearch ranking is off — no embedding model configured (Settings → Memory); keyword ranking answers alone`);
      return scores;
    }
    // Circuit breaker: within the cooldown after a failure, skip the network attempt entirely.
    if (Date.now() < this.breakerOpenUntil) return scores;

    const q = clamp(query);
    const docTexts = docs.map((d) => clamp(d.text));
    const cached = this.cache?.get(cfg.model, docTexts) ?? new Map<string, Float32Array>();
    // Distinct texts only: duplicate descriptions must not pay for one vector twice. The query rides
    // every batch (unsorted, always first) but is never persisted — see the put() below.
    const missing = [...new Set(docTexts)].filter((text) => !cached.has(text));
    const batch = [q, ...missing];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let vectors: Float32Array[];
    try {
      vectors = await this.embeddings.embedBatch(cfg, batch, controller.signal);
    } catch (e) {
      this.breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      this.warnOnce(`semantic ToolSearch ranking unavailable (${e instanceof Error ? e.message : String(e)}) — falling back to keyword ranking`);
      return scores;
    } finally {
      clearTimeout(timer);
    }
    if (vectors.length !== batch.length) {
      this.breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      this.warnOnce('semantic ToolSearch ranking unavailable (embeddings malformed response) — falling back to keyword ranking');
      return scores;
    }
    const byText = new Map<string, Float32Array>();
    batch.forEach((text, i) => byText.set(text, vectors[i]!));
    // Persist DOCUMENT vectors only. Storing the query's vector would make a stream of fresh queries
    // evict the durable tool/skill vectors through the FIFO prune (unbounded cardinality vs a fixed
    // cache cap), after which every search pays for the whole surface again.
    if (missing.length > 0) {
      this.cache?.put(cfg.model, missing.map((text) => ({ text, vector: byText.get(text)! })));
    }

    const queryVector = byText.get(q);
    if (!queryVector) return scores;
    docs.forEach((doc, i) => {
      const vector = cached.get(docTexts[i]!) ?? byText.get(docTexts[i]!);
      if (!vector) return;
      const score = cosine(queryVector, vector);
      if (score >= MIN_SEMANTIC_SCORE) scores.set(doc.id, score);
    });
    return scores;
  }

  /** At most ONE warn per process: an operator fixes a misconfiguration once; a per-query line for a
   *  flaky endpoint would only train everyone to ignore the log. */
  private warnOnce(message: string): void {
    if (this.warnedUnavailable) {
      log.debug(message);
      return;
    }
    this.warnedUnavailable = true;
    log.warn(message);
  }
}

function clamp(text: string): string {
  if (text.length <= MAX_DOC_CHARS) return text;
  // Code points, not UTF-16 units: String.slice could split a surrogate pair and hand the embedder a
  // broken string.
  return Array.from(text).slice(0, MAX_DOC_CHARS).join('');
}
