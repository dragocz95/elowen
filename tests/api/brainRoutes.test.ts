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
  const sends: { id: number; text: string; mode?: string }[] = [];
  return {
    sends,
    status: (id: number) => ({ running: started.has(id), sessionId: started.has(id) ? `brain-${id}` : null, model: 'm' }),
    start: async (id: number) => { started.add(id); return { sessionId: `brain-${id}` }; },
    send: async (id: number, text: string, _images?: unknown, mode?: string) => {
      if (!started.has(id)) throw new Error('brain not started for user');
      sends.push({ id, text, mode });
    },
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
  const brain = fakeBrain();
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    brain: brain as never,
  });
  return { app, amyTok: users.issueToken(amy.id), agentTok: users.issueToken(amy.id, 'agent'), brain };
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

  it('passes plan mode through /brain/send', async () => {
    const { app, amyTok, brain } = setup();
    await app.request('/brain/start', post(amyTok, {}));
    expect((await app.request('/brain/send', post(amyTok, { text: 'outline', mode: 'plan' }))).status).toBe(200);
    expect(brain.sends.at(-1)).toEqual({ id: 2, text: 'outline', mode: 'plan' });
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

describe('LSP status + toggle routes', () => {
  function setupLsp() {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const amy = users.create('amy', 'pw');
    const config = new ConfigStore(db);
    const app = createServer({
      tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
      brain: fakeBrain() as never,
    });
    return { app, config, adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id) };
  }

  it('GET /brain/lsp reports enabled/running plus per-server rows (readable by any chat user)', async () => {
    const { app, amyTok } = setupLsp();
    const res = await app.request('/brain/lsp', auth(amyTok));
    expect(res.status).toBe(200);
    const s = await res.json() as { enabled: boolean; running: boolean; servers: { command: string; label: string; installed: boolean; running: boolean }[] };
    expect(typeof s.enabled).toBe('boolean');
    expect(typeof s.running).toBe('boolean');
    expect(s.servers.length).toBeGreaterThan(0);
    expect(s.servers.find((x) => x.command === 'typescript-language-server')).toMatchObject({ label: 'TypeScript' });
  });

  it('per-server rows carry the install metadata for the ctrl+i flow', async () => {
    const { app, amyTok } = setupLsp();
    const s = await (await app.request('/brain/lsp', auth(amyTok))).json() as { servers: { command: string; installable: boolean; installHint: string }[] };
    expect(s.servers.find((x) => x.command === 'typescript-language-server')).toMatchObject({ installable: true, installHint: 'npm install -g typescript-language-server typescript' });
    expect(s.servers.find((x) => x.command === 'gopls')).toMatchObject({ installable: false, installHint: 'go install golang.org/x/tools/gopls@latest' });
  });

  it('POST /brain/lsp/install is admin-only and 404s an unknown server', async () => {
    const { app, adminTok, amyTok } = setupLsp();
    expect((await app.request('/brain/lsp/install', post(amyTok, { command: 'gopls' }))).status).toBe(403);
    expect((await app.request('/brain/lsp/install', post(adminTok, { command: 'not-a-server' }))).status).toBe(404);
  });

  it('POST /brain/command lsp is admin-only, flips the live manager AND persists the flag', async () => {
    const { app, config, adminTok, amyTok } = setupLsp();
    expect((await app.request('/brain/command', post(amyTok, { name: 'lsp' }))).status).toBe(403);

    const before = (await (await app.request('/brain/lsp', auth(adminTok))).json() as { enabled: boolean }).enabled;
    const r = await app.request('/brain/command', post(adminTok, { name: 'lsp' }));
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; data: { enabled: boolean } };
    expect(body.data.enabled).toBe(!before);
    expect(config.get().lspEnabled).toBe(!before); // survives a daemon restart via bootstrap re-seed
    // …and the live status endpoint agrees with the persisted flag.
    expect((await (await app.request('/brain/lsp', auth(adminTok))).json() as { enabled: boolean }).enabled).toBe(!before);
    // Flip back — the manager is a daemon-wide singleton, don't leak state into other tests.
    await app.request('/brain/command', post(adminTok, { name: 'lsp' }));
  });
});
