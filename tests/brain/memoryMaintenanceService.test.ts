import { describe, expect, it, vi } from 'vitest';
import { MemoryMaintenanceService } from '../../src/brain/memoryMaintenanceService.js';
import { MemoryCategorizer } from '../../src/brain/memoryCategorizer.js';
import type { EmbeddingService } from '../../src/embeddings/embeddingService.js';
import type { InferenceClient } from '../../src/inference/types.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { MemoryStore } from '../../src/store/memoryStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

const config = { providerId: 'openai', model: 'embed', dimensions: 3 };

function setup() {
  const db = openPluginTablesDb(':memory:');
  const memories = new MemoryStore(db);
  const categories = new MemoryCategoryStore(db);
  return { db, memories, categories };
}

async function waitDone(service: MemoryMaintenanceService, userId: number, operation: 'reindex' | 'recategorize') {
  await vi.waitFor(() => expect(service.status(userId)[operation].status).toBe('done'));
  return service.status(userId)[operation];
}

describe('MemoryMaintenanceService', () => {
  it('processes more than 450 owner-scoped items and continues after one item fails', async () => {
    const { memories } = setup();
    for (let index = 0; index < 451; index += 1) memories.add(1, { body: index === 225 ? 'bad' : `amy-${index}` }, 'test', '');
    const bob = memories.add(2, { body: 'bob-private' }, 'test', '');
    const embeddings = {
      embed: async (_config: unknown, body: string) => {
        if (body === 'bad') throw new Error('provider failure');
        return Float32Array.from([1, 2, 3]);
      },
    } as unknown as EmbeddingService;
    const service = new MemoryMaintenanceService({ memories, embeddings, embeddingConfig: () => config });

    service.startReindex(1);
    const job = await waitDone(service, 1, 'reindex');

    expect(job).toMatchObject({ total: 451, processed: 451, succeeded: 450, failed: 1 });
    expect(memories.getEmbedding(2, bob.id)).toBeUndefined();
  });

  it('returns the existing running job for a duplicate per-user operation start', async () => {
    const { memories } = setup();
    memories.add(1, { body: 'slow' }, 'test', '');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const embeddings = { embed: async () => { await blocked; return Float32Array.from([1, 2, 3]); } } as unknown as EmbeddingService;
    const service = new MemoryMaintenanceService({ memories, embeddings, embeddingConfig: () => config });

    const first = service.startReindex(1);
    const duplicate = service.startReindex(1);
    expect(duplicate.id).toBe(first.id);
    release();
    await waitDone(service, 1, 'reindex');
  });

  it('uses the body hash CAS and can be safely started again after the stale run', async () => {
    const { memories } = setup();
    const row = memories.add(1, { body: 'old body' }, 'test', '');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let slow = true;
    const embeddings = {
      embed: async () => {
        if (slow) await blocked;
        return Float32Array.from([1, 2, 3]);
      },
    } as unknown as EmbeddingService;
    const service = new MemoryMaintenanceService({ memories, embeddings, embeddingConfig: () => config });

    service.startReindex(1);
    memories.update(1, row.id, { body: 'new body' }, 'user:1', 'manual edit');
    release();
    const stale = await waitDone(service, 1, 'reindex');
    expect(stale.failed).toBe(1);
    expect(memories.getEmbedding(1, row.id)).toBeUndefined();

    slow = false;
    service.startReindex(1);
    const retried = await waitDone(service, 1, 'reindex');
    expect(retried.succeeded).toBe(1);
    expect(memories.getEmbedding(1, row.id)).toBeDefined();
  });

  it('does not let a stale embedding model overwrite a newer configuration', async () => {
    const { memories } = setup();
    const row = memories.add(1, { body: 'model race' }, 'test', '');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const embeddings = {
      embed: async () => { await blocked; return Float32Array.from([1, 2, 3]); },
    } as unknown as EmbeddingService;
    let activeConfig = config;
    const service = new MemoryMaintenanceService({ memories, embeddings, embeddingConfig: () => activeConfig });

    service.startReindex(1);
    activeConfig = { ...config, model: 'embed-v2' };
    release();
    const job = await waitDone(service, 1, 'reindex');

    expect(job).toMatchObject({ succeeded: 0, failed: 1 });
    expect(memories.getEmbedding(1, row.id)).toBeUndefined();
  });

  it('preserves a manual category change made during inference', async () => {
    const { memories, categories } = setup();
    const suggested = categories.create(1, { name: 'Suggested' });
    const manual = categories.create(1, { name: 'Manual' });
    const row = memories.add(1, { body: 'a fact' }, 'test', '');
    let answer!: (value: { text: string }) => void;
    const inference: InferenceClient = {
      model: 'classifier',
      decide: () => new Promise((resolve) => { answer = resolve; }),
    };
    const categorizer = new MemoryCategorizer({ categories, memories, inference: () => inference });
    const service = new MemoryMaintenanceService({ memories, embeddingConfig: () => config, categorizer });

    service.startRecategorize(1, 'all');
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    memories.setCategory(1, row.id, manual.id, 'user:1', 'manual category');
    answer({ text: suggested.name });
    const job = await waitDone(service, 1, 'recategorize');

    expect(job.failed).toBe(1);
    expect(memories.get(1, row.id)?.category_id).toBe(manual.id);
  });

  it('preserves a manual category ABA change made during inference', async () => {
    const { memories, categories } = setup();
    const suggested = categories.create(1, { name: 'Suggested' });
    const manual = categories.create(1, { name: 'Manual' });
    const row = memories.add(1, { body: 'a fact' }, 'test', '');
    let answer!: (value: { text: string }) => void;
    const inference: InferenceClient = {
      model: 'classifier',
      decide: () => new Promise((resolve) => { answer = resolve; }),
    };
    const categorizer = new MemoryCategorizer({ categories, memories, inference: () => inference });
    const service = new MemoryMaintenanceService({ memories, embeddingConfig: () => config, categorizer });

    service.startRecategorize(1, 'all');
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    memories.setCategory(1, row.id, manual.id, 'user:1', 'manual category');
    memories.setCategory(1, row.id, null, 'user:1', 'manual clear');
    answer({ text: suggested.name });
    const job = await waitDone(service, 1, 'recategorize');

    expect(job.failed).toBe(1);
    expect(memories.get(1, row.id)?.category_id).toBeNull();
  });

  it('rejects a model decision when its target category was deleted and recreated', async () => {
    const { memories, categories } = setup();
    const target = categories.create(1, { name: 'Target', description: 'original' });
    const row = memories.add(1, { body: 'a fact' }, 'test', '');
    let answer!: (value: { text: string }) => void;
    const inference: InferenceClient = {
      model: 'classifier',
      decide: () => new Promise((resolve) => { answer = resolve; }),
    };
    const categorizer = new MemoryCategorizer({ categories, memories, inference: () => inference });
    const service = new MemoryMaintenanceService({ memories, embeddingConfig: () => config, categorizer });

    service.startRecategorize(1, 'all');
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    expect(categories.delete(1, target.id)).toBe(true);
    const replacement = categories.create(1, { name: 'Target', description: 'replacement' });
    expect(replacement.id).toBe(target.id);
    answer({ text: target.name });
    const job = await waitDone(service, 1, 'recategorize');

    expect(job.failed).toBe(1);
    expect(memories.get(1, row.id)?.category_id).toBeNull();
  });

  it('does not persist an embedding when the memory leaves the active lifecycle during inference', async () => {
    const { memories } = setup();
    const row = memories.add(1, { body: 'temporary' }, 'test', '');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const embeddings = {
      embed: async () => { await blocked; return Float32Array.from([1, 2, 3]); },
    } as unknown as EmbeddingService;
    const service = new MemoryMaintenanceService({ memories, embeddings, embeddingConfig: () => config });

    service.startReindex(1);
    memories.softDelete(1, row.id, 'user:1', 'removed during maintenance');
    release();
    const job = await waitDone(service, 1, 'reindex');

    expect(job).toMatchObject({ succeeded: 0, failed: 1 });
    expect(memories.getEmbedding(1, row.id)).toBeUndefined();
  });

  it('refuses recategorization when the owner has no target categories', () => {
    const { memories, categories } = setup();
    memories.add(1, { body: 'uncategorized' }, 'test', '');
    const inference: InferenceClient = { model: 'classifier', decide: async () => ({ text: 'none' }) };
    const categorizer = new MemoryCategorizer({ categories, memories, inference: () => inference });
    const service = new MemoryMaintenanceService({ memories, embeddingConfig: () => config, categorizer });

    expect(() => service.startRecategorize(1, 'uncategorized')).toThrow('memory categories unavailable');
    expect(service.status(1).recategorize.status).toBe('idle');
  });

  it('rejects a category id owned by another user', async () => {
    const { memories, categories } = setup();
    const foreign = categories.create(2, { name: 'Bob' });
    const row = memories.add(1, { body: 'amy' }, 'test', '');
    const categorizer = {
      configured: () => true,
      hasCategories: () => true,
      currentModel: () => 'classifier',
      classifyDecision: async () => ({ categoryId: foreign.id, categoryFingerprint: 'foreign', model: 'classifier' }),
    } as unknown as MemoryCategorizer;
    const service = new MemoryMaintenanceService({ memories, embeddingConfig: () => config, categorizer });

    service.startRecategorize(1, 'all');
    const job = await waitDone(service, 1, 'recategorize');

    expect(job.failed).toBe(1);
    expect(memories.get(1, row.id)?.category_id).toBeNull();
  });
});
