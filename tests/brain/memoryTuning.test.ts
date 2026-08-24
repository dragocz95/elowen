import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { MemoryStore, hashBody } from '../../src/store/memoryStore.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { MemoryService } from '../../src/brain/memoryService.js';
import { MemoryCurator } from '../../src/brain/memoryCurator.js';
import type { EmbeddingConfig, EmbeddingService } from '../../src/embeddings/embeddingService.js';

/** The memory knobs the operator tunes in Settings → Elowen AI → Runtime, beyond the relevance floor
 *  covered by memorySemanticFloor.test.ts: the two dedup thresholds (write-side and recall-side), the
 *  two score weights, and the curator's per-exchange write cap. Each test pins the BEHAVIOUR the knob
 *  buys — that a different setting produces a different outcome on the same data — because a knob wired
 *  only as far as the config object would still typecheck and still do nothing. */

const CONFIG: EmbeddingConfig = { providerId: 'p', model: 'm' };

/** Deterministic embeddings, so every cosine below is exact rather than approximately intended. */
class FakeEmbeddings {
  constructor(private table: Record<string, number[]>) {}
  async embed(_cfg: EmbeddingConfig, text: string): Promise<Float32Array> {
    return Float32Array.from(this.table[text] ?? [0, 0, 0]);
  }
  async embedBatch(_cfg: EmbeddingConfig, texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => Float32Array.from(this.table[t] ?? [0, 0, 0]));
  }
}

const TABLE: Record<string, number[]> = {
  query: [1, 0, 0],
  // Weight pair. `close` matches the query better (0.95 vs 0.65) but carries the lowest importance,
  // `weighty` the reverse — so which one wins is decided purely by how the weights are set. They sit
  // 0.38 apart from each other, well under any dedup threshold, so packing keeps both.
  close: [0.95, 0.3122, 0],
  weighty: [0.65, -0.7599, 0],
  // Paraphrase pair: 0.80 to each other, both far above the relevance floor.
  first: [1, 0, 0],
  second: [0.8, 0.6, 0],
  // Write-side pair: a stored body and a new one 0.75 away from it.
  stored: [1, 0, 0],
  incoming: [0.75, 0.6614, 0],
};

let categories: MemoryCategoryStore;
let categoryId: number;
let store: MemoryStore;

function serviceWith(deps: {
  weights?: () => { importance: number; vitality: number };
  dedupe?: () => { duplicate: number; paraphrase: number };
} = {}): MemoryService {
  return new MemoryService({
    store,
    categories,
    embeddings: new FakeEmbeddings(TABLE) as unknown as EmbeddingService,
    embeddingConfig: () => CONFIG,
    ...(deps.weights ? { scoreWeightsPerMille: deps.weights } : {}),
    ...(deps.dedupe ? { dedupePerMille: deps.dedupe } : {}),
  });
}

function addWithVec(body: string, importance: number): void {
  const m = store.add(1, { body, importance }, 'agent', '');
  store.setCategory(1, m.id, categoryId, 'agent', '');
  const v = Float32Array.from(TABLE[body] ?? [0, 0, 0]);
  store.setEmbedding(1, m.id, { provider: 'p', model: 'm', dimensions: v.length, vector: v, contentHash: hashBody(body) });
}

beforeEach(() => {
  const db = openDb(':memory:');
  store = new MemoryStore(db);
  categories = new MemoryCategoryStore(db);
  categoryId = categories.create(1, { name: 'Global' }).id;
});

describe('MemoryService — operator-tunable score weights', () => {
  beforeEach(() => {
    addWithVec('close', 1);
    addWithVec('weighty', 5);
  });

  it('ranks the better query match first by default and the important one once importance is weighted up', async () => {
    const builtIn = await serviceWith().retrieve(1, 'query');
    expect(builtIn.memories[0]?.body).toBe('close');

    const importanceHeavy = await serviceWith({ weights: () => ({ importance: 300, vitality: 100 }) }).retrieve(1, 'query');
    expect(importanceHeavy.memories[0]?.body).toBe('weighty');
  });

  it('falls back to the built-in weights whole when the configured pair could exceed the score', async () => {
    // Out of the daemon's clamp, so it can only arrive through a hand-edited config — but a pair summing
    // past 1000 would drive the semantic weight NEGATIVE, inverting the ranking instead of skewing it.
    const broken = await serviceWith({ weights: () => ({ importance: 800, vitality: 800 }) }).retrieve(1, 'query');
    expect(broken.memories[0]?.body).toBe('close');
  });
});

describe('MemoryService — operator-tunable dedup thresholds', () => {
  it('drops a 0.80-cosine paraphrase at the default threshold and keeps it once the operator raises it', async () => {
    addWithVec('first', 3);
    addWithVec('second', 3);

    const builtIn = await serviceWith().retrieve(1, 'query');
    expect(builtIn.memories.map((m) => m.body)).toEqual(['first']);

    const loose = await serviceWith({ dedupe: () => ({ duplicate: 720, paraphrase: 900 }) }).retrieve(1, 'query');
    expect(loose.memories.map((m) => m.body).sort()).toEqual(['first', 'second']);
  });

  // 0.75 is deliberately on the "distinct" side of the default now: measuring the live store found that
  // two unrelated long notes reach that cosine easily, so treating it as a restatement is what caused the
  // curator to overwrite memories that were about different things.
  it('leaves a 0.75-cosine body alone at the default threshold and calls it a duplicate once it is lowered', async () => {
    addWithVec('stored', 3);

    const builtIn = await serviceWith().findSimilar(1, 'incoming');
    expect(builtIn).toEqual([]);

    const loose = await serviceWith({ dedupe: () => ({ duplicate: 700, paraphrase: 700 }) }).findSimilar(1, 'incoming');
    expect(loose.map((s) => s.memory.body)).toEqual(['stored']);
  });
});

describe('MemoryCurator — operator-tunable write cap', () => {
  function curatorWith(maxOps?: () => number) {
    const memStore = { add: vi.fn(() => ({ id: 1 })), update: vi.fn(), softDelete: vi.fn(), merge: vi.fn() };
    const service = { searchSemantic: vi.fn(async () => []), findSimilar: vi.fn(async () => []) };
    const decide = vi.fn(async () => ({
      text: JSON.stringify([
        { action: 'add', body: 'first durable fact', kind: 'fact', importance: 3 },
        { action: 'add', body: 'second durable fact', kind: 'fact', importance: 3 },
        { action: 'add', body: 'third durable fact', kind: 'fact', importance: 3 },
      ]),
    }));
    const curator = new MemoryCurator({
      store: memStore as unknown as MemoryStore,
      service: service as unknown as MemoryService,
      inference: () => ({ model: 'test-model', decide }),
      ...(maxOps ? { maxOps } : {}),
    });
    return { curator, memStore, decide };
  }

  it('applies the built-in cap when unset and the configured one when set', async () => {
    const builtIn = curatorWith();
    await builtIn.curator.run(1, 'user text', 'assistant text');
    expect(builtIn.memStore.add).toHaveBeenCalledTimes(2);

    const raised = curatorWith(() => 3);
    await raised.curator.run(1, 'user text', 'assistant text');
    expect(raised.memStore.add).toHaveBeenCalledTimes(3);
  });

  // Slicing the result to the budget is only half of it: the model has to be ASKED for that many. With the
  // built-in 2 baked into the prompt, a raised cap changed nothing — the model kept returning two.
  it('asks the model for the configured number of operations, not the built-in one', async () => {
    const raised = curatorWith(() => 5);
    await raised.curator.run(1, 'user text', 'assistant text');
    expect(raised.decide.mock.calls[0]![0]).toContain('at most 5 operations');
  });

  it('still asks for the built-in number when the operator has not set one', async () => {
    const builtIn = curatorWith();
    await builtIn.curator.run(1, 'user text', 'assistant text');
    expect(builtIn.decide.mock.calls[0]![0]).toContain('at most 2 operations');
  });

  it('writes nothing at a cap of 0, and does not spend a model call to find that out', async () => {
    const off = curatorWith(() => 0);
    await off.curator.run(1, 'user text', 'assistant text');
    expect(off.memStore.add).not.toHaveBeenCalled();
    expect(off.decide).not.toHaveBeenCalled();
  });
});
