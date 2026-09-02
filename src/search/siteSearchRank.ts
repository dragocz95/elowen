import { cosine } from '../brain/memoryService.js';

/** Request bounds for `POST /search/rank` and `POST /search/ask`. The caller is the command palette,
 *  whose index is a few hundred SHORT interface strings — these caps sit comfortably above that while
 *  keeping one request's embedding work (and one prompt) bounded no matter what a client sends. */
export const SEARCH_MAX_CANDIDATES = 400;
export const SEARCH_MAX_TEXT_CHARS = 200;
export const SEARCH_MAX_QUERY_CHARS = 200;

/** How many ranked hits come back at most. The palette shows them as a secondary group under the
 *  lexical rows, so a long tail is noise rather than help. */
export const SEARCH_RANK_TOP_N = 12;

/** Minimum cosine similarity for a candidate to count as RELATED to the query. Below this the two texts
 *  are about different things, and a suggestion group padded with unrelated pages is worse than an empty
 *  one — the lexical pass already answered whatever literally matched.
 *
 *  This is deliberately the SAME floor as memory recall's `MIN_SEMANTIC` (see brain/memoryService.ts),
 *  because it answers the identical question — "is this text about the query?" — against the same
 *  operator-configured embedding model, and that value was calibrated against a real store rather than
 *  guessed. It is a per-embedding-model constant: after changing the embedding model, re-measure before
 *  trusting it. The palette's strings are SHORTER than a memory body, and short pairs score lower on
 *  average, so this floor is if anything on the permissive side for this consumer — which is the right
 *  direction for a suggestion list that is only ever consulted when the lexical pass came up thin. */
export const SEARCH_RANK_MIN_SCORE = 0.3;

/** One thing that can be ranked: a stable id the caller maps back to its own row, and the text that
 *  stands for it (the palette sends `title · subtitle · keywords`). */
export interface RankCandidate {
  id: string;
  text: string;
}

export interface RankHit {
  id: string;
  score: number;
}

/** The durable half of the ranking: vectors already computed for `model`, keyed by their exact text.
 *  Injected rather than imported so the ranking can be tested without a database — and so a process
 *  without the store (minimal test wiring) simply embeds every time instead of failing. */
export interface SiteSearchVectorCache {
  get(model: string, texts: readonly string[]): Map<string, Float32Array>;
  put(model: string, entries: readonly { text: string; vector: Float32Array }[]): void;
}

export interface SiteSearchRankDeps {
  /** Embed a batch of texts, in input order. Wraps EmbeddingService.embedBatch at the call site so this
   *  module makes no network or credential decisions of its own. */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  /** Which embedding model the vectors belong to — part of every cache key, never a filter. */
  model: string;
  cache?: SiteSearchVectorCache;
}

/** Rank `candidates` against `query` by cosine similarity of their embeddings.
 *
 *  ONE embedding request per call: the query plus only the candidate texts that are not already cached.
 *  Since the palette sends the same few hundred index strings on every call, the steady state is a
 *  single-item batch containing just the query — which is what makes a semantic layer affordable on a
 *  keystroke-driven surface.
 *
 *  Returns at most {@link SEARCH_RANK_TOP_N} hits scoring at least {@link SEARCH_RANK_MIN_SCORE},
 *  strongest first. Ties keep the caller's candidate order, so the result is stable across calls.
 *
 *  Callers enforce the request bounds above; this function ranks what it is given. */
export async function rankSiteSearch(
  deps: SiteSearchRankDeps,
  query: string,
  candidates: readonly RankCandidate[],
): Promise<RankHit[]> {
  if (candidates.length === 0) return [];

  // Distinct texts only: several rows can legitimately carry the same text, and embedding it twice would
  // pay the provider twice for one vector.
  const texts = [...new Set(candidates.map((candidate) => candidate.text))];
  const cached = deps.cache?.get(deps.model, texts) ?? new Map<string, Float32Array>();
  const missing = texts.filter((text) => !cached.has(text));

  // The query rides in the SAME batch as the misses — one round-trip, not two — and is always index 0.
  const vectors = await deps.embedBatch([query, ...missing]);
  const queryVector = vectors[0];
  if (!queryVector) return [];

  const fresh = missing
    .map((text, i) => ({ text, vector: vectors[i + 1] }))
    .filter((entry): entry is { text: string; vector: Float32Array } => entry.vector !== undefined);
  if (fresh.length > 0) deps.cache?.put(deps.model, fresh);

  const byText = new Map(cached);
  for (const entry of fresh) byText.set(entry.text, entry.vector);

  return candidates
    .map((candidate, order) => {
      const vector = byText.get(candidate.text);
      // `cosine` already answers 0 on a width mismatch, so a vector cached under a different model width
      // scores itself out instead of poisoning the ranking.
      return { id: candidate.id, score: vector ? cosine(queryVector, vector) : 0, order };
    })
    .filter((hit) => hit.score >= SEARCH_RANK_MIN_SCORE)
    .sort((a, b) => (b.score - a.score) || (a.order - b.order))
    .slice(0, SEARCH_RANK_TOP_N)
    .map(({ id, score }) => ({ id, score }));
}
