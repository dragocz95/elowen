import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { MemoryStore, hashBody } from '../../src/store/memoryStore.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { MemoryService } from '../../src/brain/memoryService.js';
import type { RetrieveOpts } from '../../src/brain/memoryService.js';
import { memoryRecallScope } from '../../src/brain/memoryRecallScope.js';
import type { MemoryRecallScope } from '../../src/brain/memoryRecallScope.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { EmbeddingConfig, EmbeddingService } from '../../src/embeddings/embeddingService.js';
import type { Policy } from '../../src/plugins/policy.js';

const POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const CONFIG: EmbeddingConfig = { providerId: 'test', model: 'test' };

/** Three dimensions, not two: on two axes any pair of memories that both score highly against the query
 *  is necessarily similar to EACH OTHER too, so packing drops one as a paraphrase and a scope test ends
 *  up measuring deduplication instead. A third axis lets each memory be on-topic independently. */
class Embeddings {
  async embed(): Promise<Float32Array> { return Float32Array.from([1, 0, 0]); }
  async embedBatch(texts: string[]): Promise<Float32Array[]> { return texts.map(() => Float32Array.from([1, 0, 0])); }
}

function scoped<T>(scope: ReturnType<typeof memoryRecallScope>, operation: () => Promise<T>): Promise<T> {
  return runWithPolicy(POLICY, operation, { memoryRecallScope: scope });
}

describe('memory recall scope', () => {
  it('uses the longest canonical project directory and never a string prefix', () => {
    const root = mkdtempSync(join(tmpdir(), 'elowen-memory-scope-'));
    const kolin = join(root, 'kolin');
    const kolinOld = join(root, 'kolin-old');
    const nested = join(kolin, 'src');
    mkdirSync(nested, { recursive: true });
    mkdirSync(kolinOld, { recursive: true });
    const db = openDb(':memory:');
    try {
      const categories = new MemoryCategoryStore(db);
      const global = categories.create(1, { name: 'Global' });
      const project = categories.create(1, { name: 'Kolin', projectId: 7 });

      const projects = { list: () => [{ id: 7, path: kolin }] };
      const nestedScope = memoryRecallScope(1, nested, categories, projects);
      const unrelatedScope = memoryRecallScope(1, kolinOld, categories, projects);

      expect(nestedScope.projectId).toBe(7);
      expect(nestedScope.categoryIds).toEqual(new Set([global.id, project.id]));
      expect(unrelatedScope.projectId).toBeNull();
      expect(unrelatedScope.categoryIds).toEqual(new Set([global.id]));
      expect(realpathSync(kolinOld)).not.toBe(realpathSync(kolin));
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(root), 'memory-scope test left its temporary directory behind').toBe(false);
    }
  });

  it('recalls only global and current-project categories in vector, keyword and recency paths', async () => {
    const db = openDb(':memory:');
    const store = new MemoryStore(db);
    const categories = new MemoryCategoryStore(db);
    const global = categories.create(1, { name: 'Global' });
    const current = categories.create(1, { name: 'Current', projectId: 1 });
    const other = categories.create(1, { name: 'Other', projectId: 2 });
    const scope = { projectId: 1, categoryIds: new Set([global.id, current.id]) };
    const add = (body: string, categoryId: number | null, vector: Float32Array): void => {
      const memory = store.add(1, { body }, 'test', '');
      store.setCategory(1, memory.id, categoryId, 'test', '');
      store.setEmbedding(1, memory.id, { provider: 'test', model: 'test', dimensions: vector.length, vector, contentHash: hashBody(body) });
    };
    // Each on-topic against the query ([1,0,0]) on its own axis, so the two in scope are 0.6 apart from
    // one another — related enough to both be recalled, distinct enough not to read as paraphrases.
    add('global vector keyword', global.id, Float32Array.from([0.6, 0.8, 0]));
    add('current vector keyword', current.id, Float32Array.from([1, 0, 0]));
    add('other vector keyword', other.id, Float32Array.from([0.6, 0, 0.8]));
    add('uncategorized vector keyword', null, Float32Array.from([0.5, 0.6, 0.6245]));

    const vectorService = new MemoryService({
      store, embeddings: new Embeddings() as EmbeddingService, embeddingConfig: () => CONFIG,
    });
    const vector = await scoped(scope, () => vectorService.retrieve(1, 'vector'));
    expect(vector.memories.map((memory) => memory.body).sort()).toEqual(['current vector keyword', 'global vector keyword']);

    const fallbackService = new MemoryService({
      store, embeddings: new Embeddings() as EmbeddingService, embeddingConfig: () => null,
    });
    const keyword = await scoped(scope, () => fallbackService.retrieve(1, 'keyword'));
    expect(keyword.memories.map((memory) => memory.body).sort()).toEqual(['current vector keyword', 'global vector keyword']);

    const recency = await scoped(scope, () => fallbackService.retrieve(1, 'no matching words'));
    expect(recency.memories.map((memory) => memory.body).sort()).toEqual(['current vector keyword', 'global vector keyword']);
  });

  it('uses global categories only when a web chat has no cwd', async () => {
    const db = openDb(':memory:');
    const store = new MemoryStore(db);
    const categories = new MemoryCategoryStore(db);
    const global = categories.create(1, { name: 'Global' });
    const project = categories.create(1, { name: 'Project', projectId: 3 });
    const globalMemory = store.add(1, { body: 'global setting' }, 'test', '');
    const projectMemory = store.add(1, { body: 'project setting' }, 'test', '');
    store.setCategory(1, globalMemory.id, global.id, 'test', '');
    store.setCategory(1, projectMemory.id, project.id, 'test', '');
    const service = new MemoryService({ store, embeddings: new Embeddings() as EmbeddingService, embeddingConfig: () => null });
    const noCwdScope = memoryRecallScope(1, undefined, categories, { list: () => [{ id: 3, path: process.cwd() }] });

    const result = await scoped(noCwdScope, () => service.retrieve(1, 'setting'));
    expect(result.memories.map((memory) => memory.body)).toEqual(['global setting']);
  });

  it('allCategoriesScope inspects across projects, surfacing project memories the global scope hides', async () => {
    const db = openDb(':memory:');
    const store = new MemoryStore(db);
    const categories = new MemoryCategoryStore(db);
    const global = categories.create(1, { name: 'Global' });
    const project = categories.create(1, { name: 'Project', projectId: 3 });
    const globalMemory = store.add(1, { body: 'global setting' }, 'test', '');
    const projectMemory = store.add(1, { body: 'project setting' }, 'test', '');
    store.setCategory(1, globalMemory.id, global.id, 'test', '');
    store.setCategory(1, projectMemory.id, project.id, 'test', '');
    const service = new MemoryService({ store, categories, embeddings: new Embeddings() as EmbeddingService, embeddingConfig: () => null });

    // The retrieval inspector runs from a web request with no turn scope: with no explicit scope it
    // collapses to globals and hides the project memory — the regression the inspector exhibited.
    const globalOnly = await service.retrieve(1, 'setting');
    expect(globalOnly.memories.map((memory) => memory.body)).toEqual(['global setting']);

    // allCategoriesScope is the inspector's explicit cross-project scope: every category the caller owns,
    // so a project memory surfaces alongside the global one instead of being filtered out.
    const inspected = await service.retrieve(1, 'setting', { scope: service.allCategoriesScope(1) });
    expect(inspected.memories.map((memory) => memory.body).sort()).toEqual(['global setting', 'project setting']);
  });

  it('prefers an explicit live-recall scope over a foreign async scope', async () => {
    const db = openDb(':memory:');
    const store = new MemoryStore(db);
    const categories = new MemoryCategoryStore(db);
    const elowen = categories.create(1, { name: 'Elowen', projectId: 1 });
    const kolin = categories.create(1, { name: 'Kolin', projectId: 9 });
    const elowenMemory = store.add(1, { body: 'shared elowen memory' }, 'test', '');
    const kolinMemory = store.add(1, { body: 'shared kolin memory' }, 'test', '');
    store.setCategory(1, elowenMemory.id, elowen.id, 'test', '');
    store.setCategory(1, kolinMemory.id, kolin.id, 'test', '');
    const service = new MemoryService({ store, embeddings: new Embeddings() as EmbeddingService, embeddingConfig: () => null });
    const elowenScope: MemoryRecallScope = { projectId: 1, categoryIds: new Set([elowen.id]) };
    const kolinScope: MemoryRecallScope = { projectId: 9, categoryIds: new Set([kolin.id]) };
    const opts: RetrieveOpts = { scope: elowenScope };

    const result = await scoped(kolinScope, () => service.retrieve(1, 'shared', opts));

    expect(result.memories.map((memory) => memory.body)).toEqual(['shared elowen memory']);
  });
});
