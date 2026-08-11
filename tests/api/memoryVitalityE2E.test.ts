import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { MemoryStore } from '../../src/store/memoryStore.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { EmbeddingService, type ProviderResolver } from '../../src/embeddings/embeddingService.js';
import { runMemoryEvictionSweep } from '../../src/daemon/bootstrap.js';

interface MemoryDto {
  id: number;
  status: string;
  vitality: number;
}

const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const post = (token: string, body: unknown) => ({
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const put = (token: string, body: unknown) => ({
  method: 'PUT',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function embeddingFetch(vectors: Record<string, number[]>): typeof fetch {
  return (async (_url, init) => {
    const raw = init?.body;
    if (typeof raw !== 'string') throw new Error('embedding request body missing');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !('input' in parsed) || !Array.isArray(parsed.input)
      || !parsed.input.every((value): value is string => typeof value === 'string')) {
      throw new Error('embedding request input malformed');
    }
    return new Response(JSON.stringify({
      data: parsed.input.map((text) => ({ embedding: vectors[text] ?? [0, 1] })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function setup(withEmbeddings = true) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id, slug, path) VALUES (1, 'elowen', '/o')").run();
  const users = new UserStore(db);
  const user = users.create('amy', 'pw');
  const config = new ConfigStore(db);
  const memoryStore = new MemoryStore(db);
  const memoryCategoryStore = new MemoryCategoryStore(db);
  const resolveProvider: ProviderResolver = (id) => id === 'openai'
    ? { id, label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'sk-test' }
    : null;
  const embeddings = withEmbeddings ? new EmbeddingService({
    resolveProvider,
    fetchImpl: embeddingFetch({
      'evictable fallback': [0.8, 0.6],
      'recently used recall': [0.8, -0.6],
      'pinned record': [0, 1],
      'grace record': [0, 1],
      'sentinel record': [0, 1],
      recall: [1, 0],
    }),
  }) : undefined;
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    memoryStore, memoryCategoryStore,
    ...(embeddings ? { embeddings } : {}),
  });
  return { app, config, db, memoryStore, memoryCategoryStore, user, users, token: users.issueToken(user.id) };
}

async function createMemory(app: ReturnType<typeof setup>['app'], token: string, body: string, importance: number): Promise<MemoryDto> {
  const response = await app.request('/memory', post(token, { body, importance }));
  expect(response.status).toBe(201);
  return await response.json() as MemoryDto;
}

describe('memory vitality retention E2E', () => {
  it('flows from live config through DTOs, vector and fallback inspection, eviction, audit, and restore', async () => {
    const { app, config, db, memoryStore, users, user, token } = setup();
    const retention = {
      enabled: true,
      graceDays: 14,
      vitalityFloor: 60,
      halfLifeByImportance: { 1: 10, 2: 0, 3: 60, 4: 90, 5: 0 },
    };
    const configured = await app.request('/config', put(token, {
      runtime: { memoryRetention: retention },
      embedding: { providerId: 'openai', model: 'test-embedding', dimensions: 2 },
    }));
    expect(configured.status).toBe(200);
    expect(config.get().runtime.memoryRetention).toEqual(retention);

    const evictable = await createMemory(app, token, 'evictable fallback', 1);
    const used = await createMemory(app, token, 'recently used recall', 1);
    const pinned = await createMemory(app, token, 'pinned record', 5);
    const grace = await createMemory(app, token, 'grace record', 1);
    const sentinel = await createMemory(app, token, 'sentinel record', 2);
    const category = await (await app.request('/memory/categories', post(token, { name: 'Global' }))).json() as { id: number };
    for (const memory of [evictable, used, pinned, grace, sentinel]) {
      const assigned = await app.request(`/memory/${memory.id}/category`, put(token, { categoryId: category.id }));
      expect(assigned.status).toBe(200);
    }
    db.prepare("UPDATE memories SET created_at = datetime('now', '-80 days') WHERE id IN (?, ?, ?)")
      .run(evictable.id, used.id, pinned.id);
    db.prepare("UPDATE memories SET created_at = datetime('now', '-1 day') WHERE id = ?").run(grace.id);
    db.prepare("UPDATE memories SET created_at = datetime('now', '-80 days') WHERE id = ?").run(sentinel.id);
    db.prepare("UPDATE memories SET use_count = 10, last_used_at = datetime('now', '-1 day') WHERE id = ?").run(used.id);

    const reindex = await app.request('/memory/reindex', post(token, {}));
    expect(reindex.status).toBe(200);
    expect(await reindex.json()).toEqual({ embedded: 5 });

    const list = await (await app.request('/memory', auth(token))).json() as MemoryDto[];
    expect(list).toHaveLength(5);
    for (const memory of list) expect(Number.isFinite(memory.vitality)).toBe(true);
    const vitalityById = new Map(list.map((memory) => [memory.id, memory.vitality]));
    expect(vitalityById.get(used.id)).toBeGreaterThan(vitalityById.get(evictable.id) ?? Infinity);
    expect(vitalityById.get(sentinel.id)).toBe(50);

    const beforeVectorInspection = memoryStore.get(user.id, used.id);
    expect(beforeVectorInspection).toBeDefined();
    const vectorInspection = await app.request('/memory/retrieve', post(token, { query: 'recall' }));
    expect(vectorInspection.status).toBe(200);
    const vectorResult = await vectorInspection.json() as { memories: MemoryDto[]; debug: { fallback: boolean } };
    expect(vectorResult.debug.fallback).toBe(false);
    expect(vectorResult.memories.map((memory) => memory.id)).toEqual([used.id, evictable.id]);
    expect(memoryStore.get(user.id, used.id)?.use_count).toBe(beforeVectorInspection?.use_count);
    expect(memoryStore.get(user.id, used.id)?.last_used_at).toBe(beforeVectorInspection?.last_used_at);

    const fallbackConfig = await app.request('/config', put(token, { embedding: { providerId: '', model: '', dimensions: null } }));
    expect(fallbackConfig.status).toBe(200);
    const fallbackInspection = await app.request('/memory/retrieve', post(token, { query: 'fallback' }));
    expect(fallbackInspection.status).toBe(200);
    const fallbackResult = await fallbackInspection.json() as { memories: MemoryDto[]; debug: { fallback: boolean } };
    expect(fallbackResult.debug.fallback).toBe(true);
    expect(fallbackResult.memories.map((memory) => memory.id)).toContain(evictable.id);
    expect(memoryStore.get(user.id, evictable.id)?.use_count).toBe(0);
    expect(memoryStore.get(user.id, evictable.id)?.last_used_at).toBeNull();

    config.update({ runtime: { memoryRetention: { enabled: false } } });
    expect(runMemoryEvictionSweep({
      memories: memoryStore, users: { list: () => users.list() }, retention: () => config.get().runtime.memoryRetention, now: () => Date.now(),
    })).toBe(0);
    expect(memoryStore.get(user.id, evictable.id)?.status).toBe('active');
    expect((await (await app.request('/memory', auth(token))).json() as MemoryDto[])
      .find((memory) => memory.id === evictable.id)?.vitality).toBeCloseTo(vitalityById.get(evictable.id) ?? 0, 4);

    config.update({ runtime: { memoryRetention: { enabled: true } } });
    expect(runMemoryEvictionSweep({
      memories: memoryStore, users: { list: () => users.list() }, retention: () => config.get().runtime.memoryRetention, now: () => Date.now(),
    })).toBe(1);
    expect(memoryStore.get(user.id, evictable.id)?.status).toBe('deleted');
    expect(memoryStore.get(user.id, pinned.id)?.status).toBe('active');
    expect(memoryStore.get(user.id, grace.id)?.status).toBe('active');
    expect(memoryStore.get(user.id, sentinel.id)?.status).toBe('active');
    expect(memoryStore.listEvents(user.id)[0]).toMatchObject({
      memory_id: evictable.id,
      action: 'delete',
      actor: 'daemon',
      reason: expect.stringMatching(/^auto-evict: vitality \d+\.\d{2} < 60$/),
    });

    const restored = await app.request(`/memory/${evictable.id}/restore`, post(token, {}));
    expect(restored.status).toBe(200);
    expect(memoryStore.get(user.id, evictable.id)?.status).toBe('active');
    expect(memoryStore.listEvents(user.id)[0]).toMatchObject({ memory_id: evictable.id, action: 'restore' });
  });

  it('always returns a vitality DTO when embeddings are unavailable', async () => {
    const { app, token } = setup(false);
    const created = await createMemory(app, token, 'keyword-only memory', 1);
    expect(Number.isFinite(created.vitality)).toBe(true);

    const list = await (await app.request('/memory', auth(token))).json() as MemoryDto[];
    expect(Number.isFinite(list[0]?.vitality)).toBe(true);
    const detail = await (await app.request(`/memory/${created.id}`, auth(token))).json() as MemoryDto;
    expect(Number.isFinite(detail.vitality)).toBe(true);
    const search = await (await app.request('/memory?q=keyword', auth(token))).json() as MemoryDto[];
    expect(Number.isFinite(search[0]?.vitality)).toBe(true);
  });
});
