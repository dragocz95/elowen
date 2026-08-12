import { describe, expect, it } from 'vitest';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
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
import { openAgentsDb } from '../helpers/agentsDb.js';

function setup() {
  const db = openAgentsDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const amy = users.create('amy', 'pw');
  const config = new ConfigStore(db);
  const resolveProvider: ProviderResolver = (id) =>
    id === 'openai' ? { id, label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'sk-test' } : null;
  const memoryStore = new MemoryStore(db);
  const memoryCategoryStore = new MemoryCategoryStore(db);
  const embeddings = new EmbeddingService({
    resolveProvider,
    fetchImpl: (async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch,
  });
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    memoryStore, memoryCategoryStore, embeddings,
  });
  return { app, config, db, memoryStore, memoryCategoryStore, userId: amy.id, token: users.issueToken(amy.id) };
}

const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const post = (token: string, body: unknown) => ({
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('memory vitality API', () => {
  it('adds server-computed vitality to list, id, and q-search rows', async () => {
    const { app, token } = setup();
    const created = await (await app.request('/memory', post(token, { body: 'likes espresso' }))).json();

    const list = await (await app.request('/memory', auth(token))).json();
    expect(list[0]).toHaveProperty('vitality');
    expect(typeof list[0].vitality).toBe('number');

    const got = await (await app.request(`/memory/${created.id}`, auth(token))).json();
    expect(got).toHaveProperty('vitality');
    expect(typeof got.vitality).toBe('number');

    const search = await (await app.request('/memory?q=espresso', auth(token))).json();
    expect(search[0]).toHaveProperty('vitality');
    expect(typeof search[0].vitality).toBe('number');
  });

  it('uses the live retention configuration for vitality', async () => {
    const { app, config, db, memoryStore, userId, token } = setup();
    const memory = memoryStore.add(userId, { body: 'old detail', importance: 1 }, 'test', '');
    db.prepare("UPDATE memories SET created_at = datetime('now', '-120 days') WHERE id = ?").run(memory.id);
    config.update({ runtime: { memoryRetention: { halfLifeByImportance: { 1: 0 } } } });

    const list = await (await app.request('/memory', auth(token))).json() as Array<{ id: number; vitality: number }>;
    const row = list.find((item) => item.id === memory.id);

    expect(row).toBeDefined();
    expect(row?.vitality).toBe(50);
  });

  it('does not mark memories used during retrieval inspection', async () => {
    const { app, memoryStore, memoryCategoryStore, userId, token } = setup();
    const category = memoryCategoryStore.create(userId, { name: 'Global' });
    const memory = memoryStore.add(userId, { body: 'global deploy detail' }, 'test', '');
    memoryStore.setCategory(userId, memory.id, category.id, 'test', '');

    const res = await app.request('/memory/retrieve', post(token, { query: 'deploy' }));

    expect(res.status).toBe(200);
    expect((await res.json()).memories.map((row: { id: number }) => row.id)).toEqual([memory.id]);
    expect(memoryStore.get(userId, memory.id)?.use_count).toBe(0);
  });
});
