import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { MemoryStore, hashBody } from '../../src/store/memoryStore.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { MemoryService, cosine } from '../../src/brain/memoryService.js';
import type { EmbeddingConfig, EmbeddingService } from '../../src/embeddings/embeddingService.js';

/** Deterministic embedding lookup: a body/query maps to a fixed vector so cosine is fully controlled.
 *  Unknown text → zero vector. Optionally throws for a text to exercise the embed-failure fallback. */
class FakeEmbeddings {
  constructor(
    private table: Record<string, number[]>,
    private failFor?: string,
  ) {}
  async embed(_cfg: EmbeddingConfig, text: string): Promise<Float32Array> {
    if (this.failFor !== undefined && text === this.failFor) throw new Error('embed boom');
    return Float32Array.from(this.table[text] ?? [0, 0, 0]);
  }
  async embedBatch(_cfg: EmbeddingConfig, texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => Float32Array.from(this.table[t] ?? [0, 0, 0]));
  }
}

const CONFIG: EmbeddingConfig = { providerId: 'p', model: 'm' };

let categories: MemoryCategoryStore;
let globalCategoryId: number;

function makeService(
  store: MemoryStore,
  table: Record<string, number[]>,
  opts: { config?: EmbeddingConfig | null; failFor?: string; onRecalled?: (userId: number) => void } = {},
): MemoryService {
  const fake = new FakeEmbeddings(table, opts.failFor) as unknown as EmbeddingService;
  const config = opts.config === undefined ? CONFIG : opts.config;
  return new MemoryService({ store, categories, embeddings: fake, embeddingConfig: () => config, onRecalled: opts.onRecalled });
}

/** Add a memory and give it the embedding for its body from `table`. */
function addWithVec(store: MemoryStore, userId: number, body: string, table: Record<string, number[]>, importance = 3): number {
  const m = store.add(userId, { body, importance }, 'agent', '');
  store.setCategory(userId, m.id, globalCategoryId, 'agent', '');
  const v = Float32Array.from(table[body] ?? [0, 0, 0]);
  store.setEmbedding(userId, m.id, { provider: 'p', model: 'm', dimensions: v.length, vector: v, contentHash: hashBody(body) });
  return m.id;
}

describe('cosine', () => {
  it('identical → 1, orthogonal → 0, zero-norm → 0, length mismatch → 0', () => {
    expect(cosine(new Float32Array([1, 2, 3]), new Float32Array([1, 2, 3]))).toBeCloseTo(1, 6);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
    expect(cosine(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
    expect(cosine(new Float32Array([1, 2]), new Float32Array([1, 2, 3]))).toBe(0);
  });
});

describe('MemoryService.retrieve', () => {
  let store: MemoryStore;
  beforeEach(() => {
    const db = openDb(':memory:');
    store = new MemoryStore(db);
    categories = new MemoryCategoryStore(db);
    globalCategoryId = categories.create(1, { name: 'Global' }).id;
  });

  it('empty query returns nothing', async () => {
    const svc = makeService(store, {});
    const res = await svc.retrieve(1, '   ');
    expect(res.memories).toEqual([]);
  });

  it('ranks by combined score — importance lifts a slightly-less-semantic hit above a bare one', async () => {
    // The two candidates must differ on a DIFFERENT axis each, or their mutual cosine lands in the
    // paraphrase range and packing drops the second before importance can reorder anything.
    const table = {
      query: [1, 0, 0, 0],
      A: [0.8, 0.6, 0, 0],          // semantic 0.80, importance 1
      B: [0.75, 0, 0.6614, 0],      // semantic 0.75, importance 5 — mutual cosine with A is 0.60
    };
    const idA = addWithVec(store, 1, 'A', table, 1);
    const idB = addWithVec(store, 1, 'B', table, 5);
    const svc = makeService(store, table);

    const res = await svc.retrieve(1, 'query');
    expect(res.memories.map((m) => m.id)).toEqual([idB, idA]);
    expect(res.debug.fallback).toBe(false);
    expect(res.debug.provider).toBe('p');
    expect(res.debug.model).toBe('m');
    // debug carries a breakdown per candidate, with the top one flagged picked
    expect(res.debug.scores).toHaveLength(2);
    expect(res.debug.scores[0]!.id).toBe(idB);
    expect(res.debug.scores[0]!.picked).toBe(true);
  });

  // Packing used to drop a result only at cosine 0.97, which no two real memories ever reach, so two
  // write-ups of one fact could take two of the six slots. The cut-off now sits at the measured
  // duplicate range: 0.765 (the real duplicate pair) collapses, 0.659 (distinct facts) does not.
  it('drops a paraphrase of an already-picked memory, but keeps a merely related one', async () => {
    const table = {
      query: [1, 0, 0],
      original: [1, 0, 0],
      paraphrase: [0.765, Math.sqrt(1 - 0.765 ** 2), 0],
    };
    const kept = addWithVec(store, 1, 'original', table, 5);
    addWithVec(store, 1, 'paraphrase', table, 1);
    const dropped = await makeService(store, table).retrieve(1, 'query');
    expect(dropped.memories.map((m) => m.id)).toEqual([kept]);

    const db2 = openDb(':memory:');
    const store2 = new MemoryStore(db2);
    categories = new MemoryCategoryStore(db2);
    globalCategoryId = categories.create(1, { name: 'Global' }).id;
    const related = {
      query: [1, 0, 0],
      first: [1, 0, 0],
      second: [0.659, Math.sqrt(1 - 0.659 ** 2), 0],
    };
    addWithVec(store2, 1, 'first', related, 5);
    addWithVec(store2, 1, 'second', related, 1);
    const both = await makeService(store2, related).retrieve(1, 'query');
    expect(both.memories).toHaveLength(2);
  });

  it('dedupes near-identical vectors', async () => {
    const table = { query: [1, 0, 0], dup1: [1, 0, 0], dup2: [1, 0, 0] };
    addWithVec(store, 1, 'dup1', table, 5);
    addWithVec(store, 1, 'dup2', table, 1);
    const svc = makeService(store, table);

    const res = await svc.retrieve(1, 'query');
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0]!.body).toBe('dup1'); // higher importance kept
  });

  it('honors maxCount', async () => {
    // All three above the relevance floor (cos ≥ 0.3), and mutually distinct enough that packing keeps
    // them, so maxCount — not the floor and not paraphrase-dropping — is what does the capping.
    const table = {
      query: [1, 0, 0, 0],
      one: [1, 0, 0, 0],
      two: [0.5, 0.866, 0, 0],
      three: [0.5, 0, 0.866, 0],
    };
    addWithVec(store, 1, 'one', table);
    addWithVec(store, 1, 'two', table);
    addWithVec(store, 1, 'three', table);
    const svc = makeService(store, table);

    const res = await svc.retrieve(1, 'query', { maxCount: 2 });
    expect(res.memories).toHaveLength(2);
  });

  it('floors out unrelated memories — importance/recency cannot drag a low-cosine memory in', async () => {
    // "off" is semantically unrelated (cos 0) but maxed importance; it must NOT be injected.
    const table = { query: [1, 0, 0], on: [0.8, 0.6, 0], off: [0, 1, 0] };
    const idOn = addWithVec(store, 1, 'on', table, 1);
    addWithVec(store, 1, 'off', table, 5);
    const svc = makeService(store, table);

    const res = await svc.retrieve(1, 'query');
    expect(res.memories.map((m) => m.id)).toEqual([idOn]);
    // debug still explains every candidate, including the floored-out one (not picked).
    expect(res.debug.scores).toHaveLength(2);
    expect(res.debug.scores.find((s) => s.semantic === 0)!.picked).toBe(false);
  });

  it('honors charBudget (top item always admitted, rest must fit)', async () => {
    // Bodies are 10 chars each; budget 15 admits only the top one.
    const table = { query: [1, 0, 0], '0123456789': [1, 0, 0], abcdefghij: [0.99, 0.14, 0] };
    addWithVec(store, 1, '0123456789', table, 5);
    addWithVec(store, 1, 'abcdefghij', table, 1);
    const svc = makeService(store, table);

    const res = await svc.retrieve(1, 'query', { charBudget: 15 });
    expect(res.memories.map((m) => m.body)).toEqual(['0123456789']);
  });

  it('uses a strict UTF-8 byte budget when the caller needs a byte-bounded prompt frame', async () => {
    const table = { query: [1, 0, 0], 'éééééééééé': [1, 0, 0], small: [0.99, 0.14, 0] };
    addWithVec(store, 1, 'éééééééééé', table, 5); // 20 UTF-8 bytes, too large for this frame.
    addWithVec(store, 1, 'small', table, 1);
    const svc = makeService(store, table);

    const res = await svc.retrieve(1, 'query', { byteBudget: 15 });

    expect(res.memories.map((m) => m.body)).toEqual(['small']);
  });

  // Retrieval used to mark its own result, which counted passes rather than deliveries: live recall
  // issues several passes a turn and drops what it already injected, so an overlapping hit was counted
  // again without ever reaching the model a second time. Marking now belongs to whoever delivers.
  it('retrieving alone never marks anything as used', async () => {
    const table = { query: [1, 0, 0], hit: [1, 0, 0], miss: [0, 1, 0] };
    const idHit = addWithVec(store, 1, 'hit', table);
    const svc = makeService(store, table);

    await svc.retrieve(1, 'query', { maxCount: 1 });

    const row = store.get(1, idHit);
    expect(row?.use_count).toBe(0);
    expect(row?.last_used_at).toBeNull();
  });

  it('markRecalled bumps exactly the delivered set', async () => {
    const table = { query: [1, 0, 0], hit: [1, 0, 0], miss: [0, 1, 0] };
    const idHit = addWithVec(store, 1, 'hit', table);
    const idMiss = addWithVec(store, 1, 'miss', table);
    const svc = makeService(store, table);

    const res = await svc.retrieve(1, 'query', { maxCount: 1 });
    svc.markRecalled(1, res.memories.map((m) => m.id));

    expect(store.get(1, idHit)?.use_count).toBe(1);
    expect(store.get(1, idHit)?.last_used_at).not.toBeNull();
    expect(store.get(1, idMiss)?.use_count).toBe(0);
  });

  // A recall moves usage and vitality with no user action behind it, so an open memory view would sit on
  // stale numbers. The nudge is what tells it to refetch — and an empty delivery is not a recall.
  it('announces a delivered recall, and stays quiet when nothing was delivered', () => {
    const onRecalled = vi.fn();
    const id = addWithVec(store, 1, 'hit', {});
    const svc = makeService(store, {}, { onRecalled });

    svc.markRecalled(1, []);
    expect(onRecalled).not.toHaveBeenCalled();

    svc.markRecalled(1, [id]);
    expect(onRecalled).toHaveBeenCalledWith(1);
  });

  it('falls back to keyword+recency when embeddings are not configured', async () => {
    addWithVec(store, 1, 'prefers dark mode', {});
    addWithVec(store, 1, 'uses vim keybindings', {});
    const svc = makeService(store, {}, { config: null });

    const res = await svc.retrieve(1, 'dark');
    expect(res.debug.fallback).toBe(true);
    expect(res.memories.some((m) => m.body === 'prefers dark mode')).toBe(true);
    // keyword hit outranks the non-matching recent memory
    expect(res.memories[0]!.body).toBe('prefers dark mode');
  });

  it('falls back to keyword path when the embed call throws', async () => {
    addWithVec(store, 1, 'loves keyword tea', {});
    const svc = makeService(store, {}, { failFor: 'keyword' });

    const res = await svc.retrieve(1, 'keyword');
    expect(res.debug.fallback).toBe(true);
    expect(res.memories[0]!.body).toBe('loves keyword tea');
    // provider/model still reported even though the vector path failed
    expect(res.debug.provider).toBe('p');
  });
});

describe('MemoryService.searchSemantic', () => {
  let store: MemoryStore;
  beforeEach(() => {
    const db = openDb(':memory:');
    store = new MemoryStore(db);
    categories = new MemoryCategoryStore(db);
    globalCategoryId = categories.create(1, { name: 'Global' }).id;
  });

  it('ranks active memories by cosine, floors out unrelated, does not markUsed', async () => {
    const table = { query: [1, 0, 0], near: [0.95, 0.31, 0], mid: [0.8, 0.6, 0], far: [0, 1, 0] };
    const idNear = addWithVec(store, 1, 'near', table);
    const idMid = addWithVec(store, 1, 'mid', table);
    addWithVec(store, 1, 'far', table); // cos 0 → below floor, excluded
    const svc = makeService(store, table);

    const rows = await svc.searchSemantic(1, 'query', 50);
    expect(rows.map((m) => m.id)).toEqual([idNear, idMid]);
    // browsing is not recall — usage counters stay untouched
    expect(store.get(1, idNear)!.use_count).toBe(0);
  });

  it('empty query returns nothing', async () => {
    const svc = makeService(store, {});
    expect(await svc.searchSemantic(1, '  ', 50)).toEqual([]);
  });

  it('falls back to keyword when semantic finds nothing (e.g. memory not embedded yet)', async () => {
    // Embeddings ARE configured, but this memory has no stored vector → semantic returns []; an
    // exact-word search must still surface it via keyword.
    store.add(1, { body: 'likes espresso' }, 'agent', '');
    const svc = makeService(store, { query: [1, 0, 0] });
    const rows = await svc.searchSemantic(1, 'espresso', 50);
    expect(rows.map((m) => m.body)).toEqual(['likes espresso']);
  });

  it('falls back to keyword search when embeddings are not configured', async () => {
    store.add(1, { body: 'prefers dark mode' }, 'agent', '');
    store.add(1, { body: 'uses vim' }, 'agent', '');
    const svc = makeService(store, {}, { config: null });
    const rows = await svc.searchSemantic(1, 'dark', 50);
    expect(rows.map((m) => m.body)).toEqual(['prefers dark mode']);
  });

  it('falls back to keyword search when the embed call throws', async () => {
    store.add(1, { body: 'keyword tea lover' }, 'agent', '');
    const svc = makeService(store, {}, { failFor: 'keyword' });
    const rows = await svc.searchSemantic(1, 'keyword', 50);
    expect(rows.map((m) => m.body)).toEqual(['keyword tea lover']);
  });
});

describe('MemoryService.findSimilar', () => {
  let store: MemoryStore;
  beforeEach(() => {
    const db = openDb(':memory:');
    store = new MemoryStore(db);
    categories = new MemoryCategoryStore(db);
    globalCategoryId = categories.create(1, { name: 'Global' }).id;
  });

  it('flags a near-duplicate and ignores a distant memory', async () => {
    const table = {
      'lives in Prague': [1, 0, 0],
      'uses vim': [0, 1, 0],
      probe: [0.999, 0.0447, 0], // cosine ≈ 0.999 with "lives in Prague"
    };
    const near = addWithVec(store, 1, 'lives in Prague', table);
    addWithVec(store, 1, 'uses vim', table);
    const svc = makeService(store, table);

    const hits = await svc.findSimilar(1, 'probe');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.memory.id).toBe(near);
    expect(hits[0]!.similarity).toBeGreaterThan(0.85);
  });

  // Both cases below are pinned to a measurement of the real store, and that measurement has been redone
  // once already — which is the point of keeping them. The first calibration read 0.765 as "the duplicate
  // pair" off a store of 4005 pairs whose maximum WAS 0.765. Re-measured 24 Aug 2026 over 54946 pairs, the
  // maximum is 0.911 and reading the top pairs by hand found no restatement anywhere: two distinct findings
  // about one supplier reach 0.911, and pairs that are merely both long average 0.535 with a p99 of 0.774.
  // So these now pin the OPPOSITE geometry — related-but-distinct goes as high as the store's maximum, and
  // only near-identical text counts. Re-measure again after an embedding-model change.
  it('leaves the most similar pair the real store actually contains, at 0.911, alone', async () => {
    const table = {
      'two distinct findings about one supplier': [1, 0, 0],
      probe: [0.911, Math.sqrt(1 - 0.911 ** 2), 0],
    };
    addWithVec(store, 1, 'two distinct findings about one supplier', table);
    const svc = makeService(store, table);

    expect(await svc.findSimilar(1, 'probe')).toEqual([]);
  });

  it('flags a genuine restatement, which sits above anything the store reaches', async () => {
    const table = {
      'the incident write-up': [1, 0, 0],
      probe: [0.96, Math.sqrt(1 - 0.96 ** 2), 0],
    };
    const dup = addWithVec(store, 1, 'the incident write-up', table);
    const svc = makeService(store, table);

    const hits = await svc.findSimilar(1, 'probe');
    expect(hits.map((h) => h.memory.id)).toEqual([dup]);
  });

  it('returns empty when embeddings are not configured', async () => {
    addWithVec(store, 1, 'lives in Prague', { 'lives in Prague': [1, 0, 0] });
    const svc = makeService(store, {}, { config: null });
    expect(await svc.findSimilar(1, 'anything')).toEqual([]);
  });

  it('returns empty when the embed call throws', async () => {
    const table = { 'lives in Prague': [1, 0, 0], probe: [1, 0, 0] };
    addWithVec(store, 1, 'lives in Prague', table);
    const svc = makeService(store, table, { failFor: 'probe' });
    expect(await svc.findSimilar(1, 'probe')).toEqual([]);
  });
});
