import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { MemoryStore } from '../../src/store/memoryStore.js';
import { MemoryCategoryStore } from '../../src/store/memoryCategoryStore.js';
import { MemoryCategorizer } from '../../src/brain/memoryCategorizer.js';
import type { InferenceClient } from '../../src/inference/types.js';
import { EmbeddingService, type ProviderResolver } from '../../src/embeddings/embeddingService.js';

/** A stub /v1/embeddings endpoint returning a fixed 3-dim vector for every input. */
function stubFetch(vector: number[] = [0.1, 0.2, 0.3]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ data: [{ embedding: vector }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function setup(opts: { fetchImpl?: typeof fetch; embeddingConfigured?: boolean } = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db);
  const amy = users.create('amy', 'pw'); // first user → admin
  const bob = users.create('bob', 'pw');
  const config = new ConfigStore(db);
  // A configured brain provider the embedding block references (so credentials resolve).
  const resolveProvider: ProviderResolver = (id) =>
    id === 'openai' ? { id, label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'sk-test' } : null;
  if (opts.embeddingConfigured !== false) {
    config.update({ embedding: { providerId: 'openai', model: 'text-embedding-3-small', dimensions: 3 } });
  }
  const memoryStore = new MemoryStore(db);
  const embeddings = new EmbeddingService({ resolveProvider, fetchImpl: opts.fetchImpl ?? stubFetch() });
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    memoryStore, embeddings,
  });
  const up = new UserProjectStore(db);
  up.assign(bob.id, 1); // let bob's per-user surface through the project gate
  return { app, memoryStore, config, users, amyId: amy.id, bobId: bob.id, amyTok: users.issueToken(amy.id), bobTok: users.issueToken(bob.id) };
}

const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = (t: string) => ({ method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
const put = (t: string, body: unknown) => ({ method: 'PUT', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('memory routes', () => {
  it('CRUD roundtrip: create → get → list → patch', async () => {
    const { app, amyTok } = setup();
    const created = await app.request('/memory', post(amyTok, { body: 'Filip prefers dark mode', kind: 'preference', importance: 4 }));
    expect(created.status).toBe(201);
    const row = await created.json();
    expect(row).toMatchObject({ body: 'Filip prefers dark mode', kind: 'preference', importance: 4, source: 'user', status: 'active' });
    expect(typeof row.id).toBe('number');

    const got = await app.request(`/memory/${row.id}`, auth(amyTok));
    expect((await got.json()).body).toBe('Filip prefers dark mode');

    const list = await (await app.request('/memory', auth(amyTok))).json();
    expect(list).toHaveLength(1);

    const upd = await app.request(`/memory/${row.id}`, patch(amyTok, { importance: 5, body: 'Filip strongly prefers dark mode' }));
    expect(upd.status).toBe(200);
    expect(await upd.json()).toMatchObject({ importance: 5, body: 'Filip strongly prefers dark mode' });
  });

  it('list ?q= runs keyword search, ?kind= narrows', async () => {
    const { app, amyTok } = setup();
    await app.request('/memory', post(amyTok, { body: 'likes espresso', kind: 'preference' }));
    await app.request('/memory', post(amyTok, { body: 'lives in Prague', kind: 'fact' }));
    const hits = await (await app.request('/memory?q=espresso', auth(amyTok))).json();
    expect(hits).toHaveLength(1);
    expect(hits[0].body).toBe('likes espresso');
    const facts = await (await app.request('/memory?kind=fact', auth(amyTok))).json();
    expect(facts).toHaveLength(1);
    expect(facts[0].kind).toBe('fact');
  });

  it('ownership boundary — amy cannot read, patch or delete bob\'s memory', async () => {
    const { app, amyTok, bobTok } = setup();
    const bobRow = await (await app.request('/memory', post(bobTok, { body: 'bob secret' }))).json();

    // amy's list never shows bob's row.
    expect(await (await app.request('/memory', auth(amyTok))).json()).toEqual([]);
    // GET a foreign id → 404.
    expect((await app.request(`/memory/${bobRow.id}`, auth(amyTok))).status).toBe(404);
    // PATCH a foreign id → 404.
    expect((await app.request(`/memory/${bobRow.id}`, patch(amyTok, { body: 'hijacked' }))).status).toBe(404);
    // DELETE a foreign id is a no-op → bob's row survives active.
    expect((await app.request(`/memory/${bobRow.id}`, del(amyTok))).status).toBe(200);
    expect((await app.request(`/memory/${bobRow.id}`, auth(bobTok))).status).toBe(200);
  });

  it('soft-delete then restore', async () => {
    const { app, amyTok } = setup();
    const row = await (await app.request('/memory', post(amyTok, { body: 'ephemeral' }))).json();
    expect((await app.request(`/memory/${row.id}`, del(amyTok))).status).toBe(200);
    // Default list excludes soft-deleted.
    expect(await (await app.request('/memory', auth(amyTok))).json()).toEqual([]);
    // But still fetchable by id (any status) and restorable.
    expect((await (await app.request(`/memory/${row.id}`, auth(amyTok))).json()).status).toBe('deleted');
    const restored = await app.request(`/memory/${row.id}/restore`, post(amyTok, {}));
    expect(restored.status).toBe(200);
    expect(await (await app.request('/memory', auth(amyTok))).json()).toHaveLength(1);
    // Restore of a foreign/missing id → 404.
    expect((await app.request('/memory/9999/restore', post(amyTok, {}))).status).toBe(404);
  });

  it('merge folds sources into one new memory and soft-deletes them', async () => {
    const { app, amyTok } = setup();
    const a = await (await app.request('/memory', post(amyTok, { body: 'likes tea' }))).json();
    const b = await (await app.request('/memory', post(amyTok, { body: 'likes green tea' }))).json();
    const merged = await app.request('/memory/merge', post(amyTok, { ids: [a.id, b.id], body: 'likes green tea' }));
    expect(merged.status).toBe(201);
    const mRow = await merged.json();
    expect(mRow.body).toBe('likes green tea');
    // Only the merged row is active now.
    const list = await (await app.request('/memory', auth(amyTok))).json();
    expect(list.map((m: { id: number }) => m.id)).toEqual([mRow.id]);
  });

  it('events feed: per-memory trail and whole-user feed', async () => {
    const { app, amyTok, bobTok } = setup();
    const row = await (await app.request('/memory', post(amyTok, { body: 'x' }))).json();
    await app.request(`/memory/${row.id}`, patch(amyTok, { body: 'y' }));
    const trail = await (await app.request(`/memory/${row.id}/events`, auth(amyTok))).json();
    expect(trail.map((e: { action: string }) => e.action).sort()).toEqual(['add', 'update']);
    expect(trail.every((e: { memory_id: number }) => e.memory_id === row.id)).toBe(true);
    const feed = await (await app.request('/memory/events', auth(amyTok))).json();
    expect(feed.length).toBeGreaterThanOrEqual(2);
    // Per-memory trail of a foreign id → 404.
    expect((await app.request(`/memory/${row.id}/events`, auth(bobTok))).status).toBe(404);
  });

  it('retrieve returns the picked memories plus a debug breakdown', async () => {
    const { app, amyTok } = setup();
    await app.request('/memory', post(amyTok, { body: 'Filip codes in TypeScript' }));
    await app.request('/memory/reindex', post(amyTok, {})); // embed it first
    const res = await app.request('/memory/retrieve', post(amyTok, { query: 'what language' }));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.debug.query).toBe('what language');
    expect(out.debug.fallback).toBe(false);
    expect(Array.isArray(out.memories)).toBe(true);
    expect(Array.isArray(out.debug.scores)).toBe(true);
  });

  it('reindex embeds the caller\'s pending memories', async () => {
    const { app, amyTok, memoryStore, amyId } = setup();
    await app.request('/memory', post(amyTok, { body: 'a fact to embed' }));
    expect(memoryStore.needsEmbedding(amyId)).toHaveLength(1);
    const res = await app.request('/memory/reindex', post(amyTok, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ embedded: 1 });
    expect(memoryStore.needsEmbedding(amyId, { model: 'text-embedding-3-small', dimensions: 3 })).toHaveLength(0);
  });

  it('reindex 400s when embeddings are not configured', async () => {
    const { app, amyTok } = setup({ embeddingConfigured: false });
    await app.request('/memory', post(amyTok, { body: 'unembeddable' }));
    const res = await app.request('/memory/reindex', post(amyTok, {}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'embeddings not configured' });
  });

  it('embedding block read exposes configured flag', async () => {
    const { app, amyTok } = setup();
    const block = await (await app.request('/memory/embedding', auth(amyTok))).json();
    expect(block).toMatchObject({ providerId: 'openai', model: 'text-embedding-3-small', dimensions: 3, configured: true });
  });

  it('embedding test: ok with a working provider, err when it throws', async () => {
    const s = setup();
    const ok = await s.app.request('/memory/embedding/test', post(s.amyTok, {}));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, dimensions: 3, provider: 'openai', model: 'text-embedding-3-small' });

    // A fetch that throws → ok:false with an error message.
    const failing = setup({ fetchImpl: (async () => { throw new Error('boom'); }) as unknown as typeof fetch });
    const err = await failing.app.request('/memory/embedding/test', post(failing.amyTok, {}));
    const body = await err.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
  });

  it('PUT /memory/embedding is admin-gated', async () => {
    const { app, amyTok, bobTok } = setup();
    // amy (admin) may update.
    const okRes = await app.request('/memory/embedding', put(amyTok, { model: 'text-embedding-3-large', dimensions: 256 }));
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toMatchObject({ model: 'text-embedding-3-large', dimensions: 256 });
    // bob (non-admin) is forbidden.
    expect((await app.request('/memory/embedding', put(bobTok, { model: 'x' }))).status).toBe(403);
    // test probe is admin-gated too.
    expect((await app.request('/memory/embedding/test', post(bobTok, {}))).status).toBe(403);
  });
});

/** Category setup: wires the memory-category store + a categorizer whose inference is a stub returning a
 *  fixed reply (so classify decisions are deterministic and offline). `categorizationConfigured:false`
 *  makes inference() null so the categorizer reports unconfigured. */
function setupCat(opts: { categorizeReply?: string; categorizationConfigured?: boolean } = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db);
  const amy = users.create('amy', 'pw'); // first user → admin
  const bob = users.create('bob', 'pw');
  const config = new ConfigStore(db);
  const memoryStore = new MemoryStore(db);
  const memoryCategoryStore = new MemoryCategoryStore(db);
  const configured = opts.categorizationConfigured !== false;
  const stub: InferenceClient = { model: 'fake-model', decide: async () => ({ text: opts.categorizeReply ?? 'none' }) };
  const inference = (): InferenceClient | null => (configured ? stub : null);
  const memoryCategorizer = new MemoryCategorizer({ categories: memoryCategoryStore, memories: memoryStore, inference });
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    memoryStore, memoryCategoryStore, memoryCategorizer,
  });
  const up = new UserProjectStore(db);
  up.assign(bob.id, 1); // let bob's per-user surface through the project gate
  return { app, memoryStore, memoryCategoryStore, config, users, amyId: amy.id, bobId: bob.id, amyTok: users.issueToken(amy.id), bobTok: users.issueToken(bob.id) };
}

describe('memory category routes', () => {
  it('category CRUD roundtrip: create → list → patch, and a duplicate name → 409', async () => {
    const { app, amyTok } = setupCat();
    const created = await app.request('/memory/categories', post(amyTok, { name: 'Práce', description: 'work stuff', color: '#f00' }));
    expect(created.status).toBe(201);
    const cat = await created.json();
    expect(cat).toMatchObject({ name: 'Práce', description: 'work stuff', color: '#f00', is_builtin: 0 });

    const list = await (await app.request('/memory/categories', auth(amyTok))).json();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Práce');

    const upd = await app.request(`/memory/categories/${cat.id}`, patch(amyTok, { name: 'Rodina' }));
    expect(upd.status).toBe(200);
    expect((await upd.json()).name).toBe('Rodina');

    // A second category then renaming it onto an existing name → 409.
    const other = await (await app.request('/memory/categories', post(amyTok, { name: 'Zdraví' }))).json();
    expect((await app.request(`/memory/categories/${other.id}`, patch(amyTok, { name: 'Rodina' }))).status).toBe(409);
    // Creating a duplicate name outright → 409 too.
    expect((await app.request('/memory/categories', post(amyTok, { name: 'Rodina' }))).status).toBe(409);
  });

  it('category ownership boundary — bob never sees or mutates amy\'s categories', async () => {
    const { app, amyTok, bobTok } = setupCat();
    const cat = await (await app.request('/memory/categories', post(amyTok, { name: 'Soukromé' }))).json();
    expect(await (await app.request('/memory/categories', auth(bobTok))).json()).toEqual([]);
    // PATCH a foreign category id → 404 (owner-scoped miss).
    expect((await app.request(`/memory/categories/${cat.id}`, patch(bobTok, { name: 'x' }))).status).toBe(404);
    // DELETE is idempotent, but bob's foreign delete must not remove amy's category.
    expect((await app.request(`/memory/categories/${cat.id}`, del(bobTok))).status).toBe(200);
    expect(await (await app.request('/memory/categories', auth(amyTok))).json()).toHaveLength(1);
  });

  it('DELETE clears the category off referencing memories, then removes it', async () => {
    const { app, amyTok } = setupCat();
    const cat = await (await app.request('/memory/categories', post(amyTok, { name: 'Tech' }))).json();
    const mem = await (await app.request('/memory', post(amyTok, { body: 'uses vim' }))).json();
    // Assign the category, then delete it — the memory must fall back to uncategorized, not dangle.
    const setRes = await app.request(`/memory/${mem.id}/category`, put(amyTok, { categoryId: cat.id }));
    expect(setRes.status).toBe(200);
    expect((await setRes.json()).category_id).toBe(cat.id);
    expect((await app.request(`/memory/categories/${cat.id}`, del(amyTok))).status).toBe(200);
    const after = await (await app.request(`/memory/${mem.id}`, auth(amyTok))).json();
    expect(after.category_id).toBeNull();
  });

  it('PUT /memory/:id/category assigns/clears; a foreign categoryId → 404; ?categoryId filters', async () => {
    const { app, amyTok, bobTok } = setupCat();
    const cat = await (await app.request('/memory/categories', post(amyTok, { name: 'Fakta' }))).json();
    const a = await (await app.request('/memory', post(amyTok, { body: 'lives in Prague' }))).json();
    const b = await (await app.request('/memory', post(amyTok, { body: 'no category yet' }))).json();

    expect((await app.request(`/memory/${a.id}/category`, put(amyTok, { categoryId: cat.id }))).status).toBe(200);
    // Filter to that category → only a.
    const inCat = await (await app.request(`/memory?categoryId=${cat.id}`, auth(amyTok))).json();
    expect(inCat.map((m: { id: number }) => m.id)).toEqual([a.id]);
    // Uncategorized filter → only b.
    const uncat = await (await app.request('/memory?categoryId=null', auth(amyTok))).json();
    expect(uncat.map((m: { id: number }) => m.id)).toEqual([b.id]);

    // A foreign category id (bob's) must be rejected → 404, never written.
    const bobCat = await (await app.request('/memory/categories', post(bobTok, { name: 'Bob' }))).json();
    expect((await app.request(`/memory/${a.id}/category`, put(amyTok, { categoryId: bobCat.id }))).status).toBe(404);
    // Clearing with null → 200 and category_id back to null.
    const cleared = await app.request(`/memory/${a.id}/category`, put(amyTok, { categoryId: null }));
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).category_id).toBeNull();
    // A missing memory id → 404.
    expect((await app.request('/memory/9999/category', put(amyTok, { categoryId: cat.id }))).status).toBe(404);
  });

  it('GET /memory/categorization exposes configured flag; PUT is admin-gated', async () => {
    const { app, amyTok, bobTok } = setupCat();
    const initial = await (await app.request('/memory/categorization', auth(amyTok))).json();
    expect(initial).toMatchObject({ providerId: '', model: '', configured: false });
    // amy (admin) may update.
    const okRes = await app.request('/memory/categorization', put(amyTok, { providerId: 'openai', model: 'gpt-4o-mini' }));
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toMatchObject({ providerId: 'openai', model: 'gpt-4o-mini' });
    // The configured flag flips once providerId + model are set.
    expect((await (await app.request('/memory/categorization', auth(amyTok))).json()).configured).toBe(true);
    // bob (non-admin) is forbidden.
    expect((await app.request('/memory/categorization', put(bobTok, { model: 'x' }))).status).toBe(403);
  });

  it('POST /memory/reclassify 400s when categorization is unconfigured', async () => {
    const { app, amyTok } = setupCat({ categorizationConfigured: false });
    const res = await app.request('/memory/reclassify', post(amyTok, {}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'categorization not configured' });
  });

  it('POST /memory/reclassify tags the caller\'s uncategorized memories via the model', async () => {
    const { app, amyTok } = setupCat({ categorizeReply: 'Práce' });
    const cat = await (await app.request('/memory/categories', post(amyTok, { name: 'Práce', description: 'work' }))).json();
    await app.request('/memory', post(amyTok, { body: 'deadline on Friday' }));
    await app.request('/memory', post(amyTok, { body: 'standup at 9' }));
    const res = await app.request('/memory/reclassify', post(amyTok, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scanned: 2, classified: 2 });
    // Both memories now carry the category.
    const inCat = await (await app.request(`/memory?categoryId=${cat.id}`, auth(amyTok))).json();
    expect(inCat).toHaveLength(2);
  });
});
