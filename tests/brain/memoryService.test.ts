import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { MemoryStore, hashBody } from '../../src/store/memoryStore.js';
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

function makeService(
  store: MemoryStore,
  table: Record<string, number[]>,
  opts: { config?: EmbeddingConfig | null; failFor?: string } = {},
): MemoryService {
  const fake = new FakeEmbeddings(table, opts.failFor) as unknown as EmbeddingService;
  const config = opts.config === undefined ? CONFIG : opts.config;
  return new MemoryService({ store, embeddings: fake, embeddingConfig: () => config });
}

/** Add a memory and give it the embedding for its body from `table`. */
function addWithVec(store: MemoryStore, userId: number, body: string, table: Record<string, number[]>, importance = 3): number {
  const m = store.add(userId, { body, importance }, 'agent', '');
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
  beforeEach(() => { store = new MemoryStore(openDb(':memory:')); });

  it('empty query returns nothing', async () => {
    const svc = makeService(store, {});
    const res = await svc.retrieve(1, '   ');
    expect(res.memories).toEqual([]);
  });

  it('ranks by combined score — importance lifts a slightly-less-semantic hit above a bare one', async () => {
    const table = {
      query: [1, 0, 0],
      A: [1, 0, 0],                 // semantic 1.0, importance 1
      B: [0.9, 0.4359, 0],          // semantic 0.9, importance 5
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
    // All three above the relevance floor (cos ≥ 0.3) so maxCount — not the floor — does the capping.
    const table = { query: [1, 0, 0], one: [1, 0, 0], two: [0.9, 0.436, 0], three: [0.8, 0.6, 0] };
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

  it('markUsed bumps only the returned set', async () => {
    const table = { query: [1, 0, 0], hit: [1, 0, 0], miss: [0, 1, 0] };
    const idHit = addWithVec(store, 1, 'hit', table);
    const idMiss = addWithVec(store, 1, 'miss', table);
    const svc = makeService(store, table);

    await svc.retrieve(1, 'query', { maxCount: 1 });
    expect(store.get(1, idHit)!.use_count).toBe(1);
    expect(store.get(1, idHit)!.last_used_at).not.toBeNull();
    expect(store.get(1, idMiss)!.use_count).toBe(0);
  });

  it('falls back to keyword+recency when embeddings are not configured', async () => {
    store.add(1, { body: 'prefers dark mode' }, 'agent', '');
    store.add(1, { body: 'uses vim keybindings' }, 'agent', '');
    const svc = makeService(store, {}, { config: null });

    const res = await svc.retrieve(1, 'dark');
    expect(res.debug.fallback).toBe(true);
    expect(res.memories.some((m) => m.body === 'prefers dark mode')).toBe(true);
    // keyword hit outranks the non-matching recent memory
    expect(res.memories[0]!.body).toBe('prefers dark mode');
  });

  it('falls back to keyword path when the embed call throws', async () => {
    store.add(1, { body: 'loves keyword tea' }, 'agent', '');
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
  beforeEach(() => { store = new MemoryStore(openDb(':memory:')); });

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
  beforeEach(() => { store = new MemoryStore(openDb(':memory:')); });

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
