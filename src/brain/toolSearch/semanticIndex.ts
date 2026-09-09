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
  /** Vector cache for tool/skill descriptions and queries. Absent → embed every time (tests). */
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

/** Longest document text embedded verbatim. Tool descriptions are capped well below this by the prompt
 *  pipeline; the clamp only bounds a hostile/outlier schema so one batch stays one batch. */
const MAX_DOC_CHARS = 1_000;

/** Cosine-ranks documents against a query, backed by the shared EmbeddingService and the durable
 *  `search_vectors` cache.
 *
 *  Budget, enforced per call: AT MOST ONE embedding request, carrying the query and only the documents
 *  whose vectors are not cached yet. The query rides the cache too, so the steady state on this
 *  instance — 180 tool + 11 skill descriptions already cached after the first search — is a single
 *  one-item batch per distinct query. Any failure (no embedding model configured, timeout, endpoint
 *  error) returns an EMPTY map, which the caller reads as "rank by keywords": the tool degrades, never
 *  breaks. At most one WARN per boot, whichever condition trips it first. */
export class ToolSemanticIndex {
  private readonly embeddings: ToolSemanticIndexDeps['embeddings'];
  private readonly embeddingConfig: ToolSemanticIndexDeps['embeddingConfig'];
  private readonly cache?: SemanticVectorCache;
  private readonly timeoutMs: number;
  private warnedUnavailable = false;

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

    const q = clamp(query);
    const docTexts = docs.map((d) => clamp(d.text));
    const cached = this.cache?.get(cfg.model, [q, ...docTexts]) ?? new Map<string, Float32Array>();
    // Distinct texts only: duplicate descriptions must not pay for one vector twice.
    const missing = [...new Set([q, ...docTexts])].filter((text) => !cached.has(text));

    if (missing.length > 0) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let vectors: Float32Array[];
      try {
        vectors = await this.embeddings.embedBatch(cfg, missing, controller.signal);
      } catch (e) {
        this.warnOnce(`semantic ToolSearch ranking unavailable (${e instanceof Error ? e.message : String(e)}) — falling back to keyword ranking`);
        return scores;
      } finally {
        clearTimeout(timer);
      }
      if (vectors.length !== missing.length) {
        this.warnOnce('semantic ToolSearch ranking unavailable (embeddings malformed response) — falling back to keyword ranking');
        return scores;
      }
      const fresh = missing.map((text, i) => ({ text, vector: vectors[i]! }));
      this.cache?.put(cfg.model, fresh);
      for (const entry of fresh) cached.set(entry.text, entry.vector);
    }

    const queryVector = cached.get(q);
    if (!queryVector) return scores;
    docs.forEach((doc, i) => {
      const vector = cached.get(docTexts[i]!);
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
  return text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text;
}