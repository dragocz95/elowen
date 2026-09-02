import { describe, it, expect } from 'vitest';
import {
  rankSiteSearch, SEARCH_RANK_MIN_SCORE, SEARCH_RANK_TOP_N,
  type RankCandidate, type SiteSearchVectorCache,
} from '../../src/search/siteSearchRank.js';

/** The ranking is pure given an embedder, so the fixture below constructs vectors at EXACT cosines to the
 *  query instead of pretending to be a language model. `atCosine(c)` returns a unit vector whose cosine
 *  against the query is c: c·q + √(1−c²)·u, with u a unit vector orthogonal to q. That makes the score of
 *  every fixture row a number the test chose, which is what lets the threshold be reasoned about. */
const QUERY_VECTOR = Float32Array.from([1, 0, 0]);
const ORTHOGONAL = Float32Array.from([0, 1, 0]);

function atCosine(c: number): Float32Array {
  const rest = Math.sqrt(Math.max(0, 1 - c * c));
  return Float32Array.from([0, 1, 2].map((i) => c * QUERY_VECTOR[i]! + rest * ORTHOGONAL[i]!));
}

/** The assumed similarity distribution the threshold is tuned against.
 *
 *  It is NOT a recording from a live provider — this repository's tests never reach one — but the bands
 *  are the ones the memory store's own calibration reports for the same class of question (see
 *  MIN_SEMANTIC in brain/memoryService.ts): genuinely related text lands around 0.4–0.65, unrelated noise
 *  around 0.05–0.25, and there is an empty stretch in between. The test's job is to pin that
 *  SEARCH_RANK_MIN_SCORE stays inside that stretch: moving it to 0.2 would start admitting noise, moving
 *  it to 0.4 would start dropping the cross-lingual paraphrase this whole layer exists for. */
const RELATED: { id: string; cosine: number; why: string }[] = [
  { id: 'settings:brain:brain.maxSteps', cosine: 0.62, why: 'cross-lingual paraphrase — "tahů max" vs "Maximum kroků"' },
  { id: 'settings:brain:brain.limits.title', cosine: 0.51, why: 'same topic, different wording' },
  { id: 'settings:brain', cosine: 0.44, why: 'the section that contains the row' },
  { id: 'page:settings', cosine: 0.36, why: 'weakly related but still on topic' },
];
const UNRELATED: { id: string; cosine: number; why: string }[] = [
  { id: 'account:notifications', cosine: 0.24, why: 'top of the noise band' },
  { id: 'page:files', cosine: 0.15, why: 'unrelated page' },
  { id: 'account:security', cosine: 0.04, why: 'unrelated section' },
];

const FIXTURE = [...RELATED, ...UNRELATED];

/** An embedder over the fixture: index 0 is always the query, the rest are looked up by candidate text
 *  (which the fixture makes equal to the candidate id). Records every batch it was asked for. */
function fixtureEmbedder() {
  const batches: string[][] = [];
  const byText = new Map(FIXTURE.map((row) => [row.id, atCosine(row.cosine)]));
  return {
    batches,
    embedBatch: async (texts: string[]) => {
      batches.push(texts);
      return texts.map((text, i) => (i === 0 ? QUERY_VECTOR : byText.get(text) ?? ORTHOGONAL));
    },
  };
}

const candidates: RankCandidate[] = FIXTURE.map((row) => ({ id: row.id, text: row.id }));

/** An in-memory stand-in for SearchVectorStore, so the caching contract can be exercised without a DB. */
function fakeCache(): SiteSearchVectorCache & { size: () => number } {
  const store = new Map<string, Float32Array>();
  const key = (model: string, text: string) => `${model}\u0000${text}`;
  return {
    get: (model, texts) => new Map(texts.flatMap((text) => {
      const hit = store.get(key(model, text));
      return hit ? [[text, hit] as const] : [];
    })),
    put: (model, entries) => { for (const e of entries) store.set(key(model, e.text), e.vector); },
    size: () => store.size,
  };
}

describe('rankSiteSearch', () => {
  it('keeps the related band and drops the noise band at SEARCH_RANK_MIN_SCORE', async () => {
    const embedder = fixtureEmbedder();
    const hits = await rankSiteSearch({ embedBatch: embedder.embedBatch, model: 'm' }, 'nastavení tahů max', candidates);

    expect(hits.map((hit) => hit.id)).toEqual(RELATED.map((row) => row.id));
    // Strongest first, and the scores really are the cosines the fixture asked for.
    for (const [i, hit] of hits.entries()) expect(hit.score).toBeCloseTo(RELATED[i]!.cosine, 5);
    for (const row of UNRELATED) expect(hits.some((hit) => hit.id === row.id)).toBe(false);
  });

  // The tuning itself, stated as a range rather than a value: this is the assertion that fails when the
  // constant is moved, and the fixture bands above are the argument for where the gap is.
  it('pins the threshold inside the gap between the two bands', () => {
    const weakestRelated = Math.min(...RELATED.map((row) => row.cosine));
    const strongestNoise = Math.max(...UNRELATED.map((row) => row.cosine));
    expect(SEARCH_RANK_MIN_SCORE).toBeGreaterThan(strongestNoise);
    expect(SEARCH_RANK_MIN_SCORE).toBeLessThan(weakestRelated);
  });

  it('embeds the query plus only the uncached candidates — a second call embeds the query alone', async () => {
    const embedder = fixtureEmbedder();
    const cache = fakeCache();
    const deps = { embedBatch: embedder.embedBatch, model: 'm', cache };

    await rankSiteSearch(deps, 'first', candidates);
    expect(embedder.batches[0]).toEqual(['first', ...FIXTURE.map((row) => row.id)]);
    expect(cache.size()).toBe(FIXTURE.length);

    await rankSiteSearch(deps, 'second', candidates);
    expect(embedder.batches[1]).toEqual(['second']);
  });

  it('embeds one vector per DISTINCT text, however many rows share it', async () => {
    const embedder = fixtureEmbedder();
    const shared = 'settings:brain:brain.maxSteps';
    await rankSiteSearch({ embedBatch: embedder.embedBatch, model: 'm' }, 'q', [
      { id: 'a', text: shared }, { id: 'b', text: shared }, { id: 'c', text: shared },
    ]);
    expect(embedder.batches[0]).toEqual(['q', shared]);
  });

  it('caps the result at SEARCH_RANK_TOP_N, keeping the strongest', async () => {
    // Every row is comfortably above the floor and strictly ordered, so the cap is the only thing
    // deciding what comes back.
    const many = Array.from({ length: SEARCH_RANK_TOP_N + 5 }, (_, i) => ({ id: `row-${i}`, text: `row-${i}` }));
    const scores = new Map(many.map((row, i) => [row.text, atCosine(0.9 - i * 0.01)]));
    const hits = await rankSiteSearch({
      embedBatch: async (texts) => texts.map((text, i) => (i === 0 ? QUERY_VECTOR : scores.get(text)!)),
      model: 'm',
    }, 'q', many);

    expect(hits).toHaveLength(SEARCH_RANK_TOP_N);
    expect(hits.map((hit) => hit.id)).toEqual(many.slice(0, SEARCH_RANK_TOP_N).map((row) => row.id));
  });

  it('answers nothing for no candidates without touching the embedder', async () => {
    const embedder = fixtureEmbedder();
    expect(await rankSiteSearch({ embedBatch: embedder.embedBatch, model: 'm' }, 'q', [])).toEqual([]);
    expect(embedder.batches).toHaveLength(0);
  });

  // A vector cached under a different model WIDTH must not score: cosine answers 0 on a length mismatch,
  // so the row falls under the floor instead of ranking on a comparison that has no meaning.
  it('scores a width-mismatched cached vector out rather than ranking it', async () => {
    const cache = fakeCache();
    cache.put('m', [{ text: 'x', vector: Float32Array.from([1, 0, 0, 0, 0]) }]);
    const hits = await rankSiteSearch({
      embedBatch: async () => [QUERY_VECTOR],
      model: 'm',
      cache,
    }, 'q', [{ id: 'x', text: 'x' }]);
    expect(hits).toEqual([]);
  });
});
