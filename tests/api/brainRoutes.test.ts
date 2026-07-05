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

function fakeBrain() {
  const started = new Set<number>();
  return {
    status: (id: number) => ({ running: started.has(id), sessionId: started.has(id) ? `brain-${id}` : null, model: 'm' }),
    start: async (id: number) => { started.add(id); return { sessionId: `brain-${id}` }; },
    send: async (id: number, _text: string) => { if (!started.has(id)) throw new Error('brain not started for user'); },
    subscribe: () => () => {},
    stop: (id: number) => { started.delete(id); },
    history: (_id: number) => [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }],
    searchMessages: (id: number, q: string) =>
      q.trim().length < 2 ? [] : [{ sessionId: `s-${id}`, sessionTitle: 'T', role: 'user', snippet: q, ts: '2026-01-01 00:00:00' }],
  };
}

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db);
  users.create('admin', 'pw');
  const amy = users.create('amy', 'pw');
  const config = new ConfigStore(db);
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    brain: fakeBrain() as never,
  });
  return { app, amyTok: users.issueToken(amy.id), agentTok: users.issueToken(amy.id, 'agent') };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('brain routes', () => {
  it('status → start → send happy path', async () => {
    const { app, amyTok } = setup();
    expect((await (await app.request('/brain/status', auth(amyTok))).json() as { running: boolean }).running).toBe(false);
    const start = await app.request('/brain/start', post(amyTok, {}));
    expect(start.status).toBe(201);
    expect((await start.json() as { sessionId: string }).sessionId).toBe('brain-2');
    expect((await (await app.request('/brain/status', auth(amyTok))).json() as { running: boolean }).running).toBe(true);
    expect((await app.request('/brain/send', post(amyTok, { text: 'hi' }))).status).toBe(200);
  });

  it('messages returns the display history', async () => {
    const { app, amyTok } = setup();
    const res = await app.request('/brain/messages', auth(amyTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }]);
  });

  it('send before start returns 409', async () => {
    const { app, amyTok } = setup();
    expect((await app.request('/brain/send', post(amyTok, { text: 'hi' }))).status).toBe(409);
  });

  it('send requires the text field (400)', async () => {
    const { app, amyTok } = setup();
    await app.request('/brain/start', post(amyTok, {}));
    expect((await app.request('/brain/send', post(amyTok, {}))).status).toBe(400);
  });

  it('an agent-scoped token cannot use brain routes', async () => {
    const { app, agentTok } = setup();
    expect((await app.request('/brain/status', auth(agentTok))).status).toBe(403);
    expect((await app.request('/brain/start', post(agentTok, {}))).status).toBe(403);
    expect((await app.request('/brain/send', post(agentTok, { text: 'x' }))).status).toBe(403);
    expect((await app.request('/brain/messages', auth(agentTok))).status).toBe(403);
    expect((await app.request('/brain/search?q=hi', auth(agentTok))).status).toBe(403);
  });

  it('search scopes to the caller and passes q through; short q yields []', async () => {
    const { app, amyTok } = setup();
    const hits = await (await app.request('/brain/search?q=daemon', auth(amyTok))).json() as { sessionId: string; snippet: string }[];
    expect(hits).toEqual([{ sessionId: 's-2', sessionTitle: 'T', role: 'user', snippet: 'daemon', ts: '2026-01-01 00:00:00' }]);
    expect(await (await app.request('/brain/search?q=d', auth(amyTok))).json()).toEqual([]);
    expect(await (await app.request('/brain/search', auth(amyTok))).json()).toEqual([]);
  });
});

describe('GET /brain/models allow-list', () => {
  function setupWithProviders() {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const amy = users.create('amy', 'pw');
    const config = new ConfigStore(db);
    config.update({ brain: { providers: [
      { id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x', models: ['kimi', 'glm'], apiKey: 'k' },
    ] } } as never);
    const app = createServer({
      tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
      brain: fakeBrain() as never,
    });
    return { app, db, users, config, adminTok: users.issueToken(admin.id), amy, amyTok: users.issueToken(amy.id) };
  }

  it('every item carries its orca exec spec; admin sees everything', async () => {
    const { app, adminTok } = setupWithProviders();
    const models = await (await app.request('/brain/models', auth(adminTok))).json() as { exec: string }[];
    expect(models.map((m) => m.exec)).toEqual(['orca:relay/kimi', 'orca:relay/glm']);
  });

  it('a non-admin sees every configured brain model (not global-bounded), narrowed only by their personal list', async () => {
    const { app, users, amy, amyTok } = setupWithProviders();
    // Brain execs aren't bounded by allowedExecs (CLI-only) — an empty personal list = every configured
    // brain model. (The bug this guards against: a non-admin getting an EMPTY model picker.)
    let models = await (await app.request('/brain/models', auth(amyTok))).json() as { exec: string }[];
    expect(models.map((m) => m.exec)).toEqual(['orca:relay/kimi', 'orca:relay/glm']);
    // A personal whitelist narrows further.
    users.setAllowedExecs(amy.id, ['orca:relay/glm']);
    models = await (await app.request('/brain/models', auth(amyTok))).json() as { exec: string }[];
    expect(models.map((m) => m.exec)).toEqual(['orca:relay/glm']);
  });
});
