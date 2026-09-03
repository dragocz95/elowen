import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import type { Db } from '../../src/store/db.js';
import { MemoryStore, hashBody } from '../../src/store/memoryStore.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { MemoryService } from '../../src/brain/memoryService.js';
import { memoryRecallScope } from '../../src/brain/memoryRecallScope.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { EmbeddingConfig, EmbeddingService } from '../../src/embeddings/embeddingService.js';
import type { Policy } from '../../src/plugins/policy.js';

const POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const CONFIG: EmbeddingConfig = { providerId: 'test', model: 'test' };

/** Everything on one axis so any in-scope memory matches the query and only scope decides admission. */
class Embeddings {
  async embed(): Promise<Float32Array> { return Float32Array.from([1, 0, 0]); }
  async embedBatch(texts: string[]): Promise<Float32Array[]> { return texts.map(() => Float32Array.from([1, 0, 0])); }
}

function scoped<T>(scope: ReturnType<typeof memoryRecallScope>, operation: () => Promise<T>): Promise<T> {
  return runWithPolicy(POLICY, operation, { memoryRecallScope: scope });
}

describe('shared memory recall scope', () => {
  const setup = () => {
    const db: Db = openDb(':memory:');
    const store = new MemoryStore(db);
    const projects = new ProjectStore(db);
    const userProjects = new UserProjectStore(db);
    // The scope resolver canonicalizes project paths with realpath, so the shop needs a REAL directory —
    // a fictional path would silently drop the project from the scope and skew every assertion.
    const root = mkdtempSync(join(tmpdir(), 'elowen-shared-mem-'));
    mkdirSync(join(root, 'obchod'), { recursive: true });
    const shop = projects.create({ slug: 'obchod', path: join(root, 'obchod') });
    projects.update(shop.id, { memoryShared: true });
    userProjects.assign(10, shop.id);
    userProjects.assign(11, shop.id);
    userProjects.assign(12, shop.id); // member, but nobody shares with him (explicit list below)
    userProjects.setMemoryMembers(shop.id, [10, 11]);
    return { db, store, categories: new MemoryCategoryStore(db), projects, userProjects, shop, root };
  };

  const cleanup = (state: ReturnType<typeof setup>): void => {
    state.db.close();
    rmSync(state.root, { recursive: true, force: true });
  };

  const seedShared = (state: ReturnType<typeof setup>, author: number, body: string): number => {
    const pool = state.categories.sharedForProject(author, { id: state.shop.id, slug: state.shop.slug })!;
    const memory = state.store.add(author, { body }, 'test', '');
    state.store.setCategory(author, memory.id, pool.id, 'test', '');
    state.store.setEmbedding(author, memory.id, {
      provider: 'test', model: 'test', dimensions: 3, vector: Float32Array.from([1, 0, 0]), contentHash: hashBody(body),
    });
    return memory.id;
  };

  const scopeFor = (state: ReturnType<typeof setup>, userId: number) =>
    memoryRecallScope(userId, state.shop.path, state.categories, {
      list: () => [{ id: state.shop.id, path: state.shop.path }],
    });

  it('scope admits the shared pool only for a sharer, only inside the project', () => {
    const state = setup();
    try {
      // The pool row exists only once a sharer has used it — create it like the write path does.
      state.categories.sharedForProject(10, { id: state.shop.id, slug: state.shop.slug });
      const authorScope = scopeFor(state, 10);
      expect(authorScope.projectId).toBe(state.shop.id);
      expect(authorScope.sharedCategoryIds.size).toBe(1);
      // The pool id rides INSIDE categoryIds, so recall's category filter needs no shared special-case.
      const poolId = [...authorScope.sharedCategoryIds][0]!;
      expect(authorScope.categoryIds.has(poolId)).toBe(true);

      // Non-sharer member: no shared ids at all.
      expect(scopeFor(state, 12).sharedCategoryIds.size).toBe(0);

      // Outside the project the pool drops out by the ordinary project-binding predicate.
      const outside = memoryRecallScope(10, undefined, state.categories, { list: () => [{ id: state.shop.id, path: state.shop.path }] });
      expect(outside.projectId).toBeNull();
      expect(outside.sharedCategoryIds.size).toBe(0);
    } finally {
      cleanup(state);
    }
  });

  it('a sharer recalls another member\'s shared memory; a non-sharer never does', async () => {
    const state = setup();
    try {
      seedPersonal(state);
      seedShared(state, 10, 'pricing rule of the shop');

      const service = new MemoryService({
        store: state.store, categories: state.categories,
        embeddings: new Embeddings() as EmbeddingService, embeddingConfig: () => CONFIG,
        sharedCategoriesOf: (userId) => state.categories.listShared(userId).map((c) => c.id),
      });

      // Vector path: Pavel's (10) memory surfaces for Jirka (11) inside the project.
      const reader = await scoped(scopeFor(state, 11), () => service.retrieve(11, 'pricing'));
      expect(reader.memories.map((m) => m.body)).toEqual(['pricing rule of the shop']);

      // The non-sharer gets nothing — the pool is not in his scope.
      const excluded = await scoped(scopeFor(state, 12), () => service.retrieve(12, 'pricing'));
      expect(excluded.memories).toHaveLength(0);

      // Keyword fallback (no embeddings wired) behaves identically on the shared row; the recency leg
      // may also legitimately surface the reader's OWN global memory, so assert on the shared one.
      const fallback = new MemoryService({
        store: state.store, categories: state.categories,
        embeddings: new Embeddings() as EmbeddingService, embeddingConfig: () => null,
        sharedCategoriesOf: (userId) => state.categories.listShared(userId).map((c) => c.id),
      });
      const keyword = await scoped(scopeFor(state, 11), () => fallback.retrieve(11, 'pricing'));
      expect(keyword.memories.map((m) => m.body)).toContain('pricing rule of the shop');
      const keywordExcluded = await scoped(scopeFor(state, 12), () => fallback.retrieve(12, 'pricing'));
      expect(keywordExcluded.memories).toHaveLength(0);
    } finally {
      cleanup(state);
    }
  });

  it('the inspector scope includes the caller\'s shared pools without leaking other projects\' pools', async () => {
    const state = setup();
    try {
      const sharedId = seedShared(state, 10, 'pricing rule of the shop');
      const service = new MemoryService({
        store: state.store, categories: state.categories,
        embeddings: new Embeddings() as EmbeddingService, embeddingConfig: () => CONFIG,
        sharedCategoriesOf: (userId) => state.categories.listShared(userId).map((c) => c.id),
      });
      const inspected = await service.retrieve(11, 'pricing', { scope: service.allCategoriesScope(11) });
      expect(inspected.memories.map((m) => m.id)).toContain(sharedId);

      // Drop 11 from the share list → the pool leaves both his scope and his inspector view.
      state.userProjects.setMemoryMembers(state.shop.id, [10]);
      const gone = await service.retrieve(11, 'pricing', { scope: service.allCategoriesScope(11) });
      expect(gone.memories.map((m) => m.id)).not.toContain(sharedId);
    } finally {
      cleanup(state);
    }
  });

  /** A personal global memory on an ORTHOGONAL axis with a body that misses the query word: it can
   *  never ride into the results, so every assertion proves the SHARED row changed the answer. */
  function seedPersonal(state: ReturnType<typeof setup>): void {
    const global = state.categories.create(11, { name: 'Personal' });
    const body = 'personal note about the coffee machine';
    const memory = state.store.add(11, { body }, 'test', '');
    state.store.setCategory(11, memory.id, global.id, 'test', '');
    state.store.setEmbedding(11, memory.id, {
      provider: 'test', model: 'test', dimensions: 3, vector: Float32Array.from([0, 1, 0]), contentHash: hashBody(body),
    });
  }
});
