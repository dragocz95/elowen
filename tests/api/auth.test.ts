import { describe, it, expect } from 'vitest';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { PushSubscriptionStore } from '../../src/store/pushSubscriptionStore.js';
import { agentsPluginProvider } from '../helpers/testApp.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

function makeAuthedApp() {
  const db = openPluginTablesDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db); users.create('alice', 'secret');
  const brainStore = new BrainStore(db);
  const pushSubscriptions = new PushSubscriptionStore(db);
  const tasks = new TaskStore(db);
  const readiness = new Readiness(db);
  const config = new ConfigStore(db);
  const projects = new ProjectStore(db);
  const app = createServer({
    tasks, missions: new MissionStore(db),
    bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, brainStore, pushSubscriptions,
    // The /tasks surface is served by the work plugin's root-mounted routes now.
    plugins: agentsPluginProvider({ db, tasks, readiness, config, projects, users }),
  });
  return { app, users, brainStore, pushSubscriptions };
}

describe('auth', () => {
  it('POST /auth/login returns a token for valid creds, 401 otherwise', async () => {
    const { app } = makeAuthedApp();
    const ok = await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'secret' }) });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(typeof body.token).toBe('string');
    expect(body.user.username).toBe('alice');
    expect(body.tokenTtlDays).toBe(30); // surfaced so the web BFF can persist the cookie for the token's lifetime
    const bad = await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'nope' }) });
    expect(bad.status).toBe(401);
  });

  it('POST /auth/login returns 400 on a missing/partial body (not an unhandled 500)', async () => {
    const { app } = makeAuthedApp();
    // No body at all: c.req.json() throws — must surface as a client 400, not a server 500.
    expect((await app.request('/auth/login', { method: 'POST' })).status).toBe(400);
    // Body present but missing the password field.
    const partial = await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice' }) });
    expect(partial.status).toBe(400);
  });

  it('rate-limits repeated login attempts from one IP (429 after the window cap)', async () => {
    const { app } = makeAuthedApp();
    const attempt = () => app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '10.0.0.9' },
      body: JSON.stringify({ username: 'alice', password: 'nope' }),
    });
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await attempt()).status; // 10 allowed (401), the 11th is blocked
    expect(last).toBe(429);
  });

  it('protects routes: 401 without token, 200 with Bearer; rejects a ?token= query token', async () => {
    const { app } = makeAuthedApp();
    expect((await app.request('/tasks')).status).toBe(401);
    // /projects (incl. mutating POST + git shell-out) and /activity must be gated too
    expect((await app.request('/projects')).status).toBe(401);
    expect((await app.request('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await app.request('/activity')).status).toBe(401);
    const login = await (await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'secret' }) })).json();
    const t = login.token as string;
    expect((await app.request('/tasks', { headers: { authorization: `Bearer ${t}` } })).status).toBe(200);
    // A token in the query string is no longer accepted — it leaks into logs/Referer and nothing uses
    // it (the web app authenticates via the BFF-injected Bearer header). Only the header is honoured.
    expect((await app.request(`/tasks?token=${t}`)).status).toBe(401);
  });

  it('keeps /health public without a token', async () => {
    const { app } = makeAuthedApp();
    expect((await app.request('/health')).status).toBe(200);
  });

  it('POST /users creates (409 on duplicate) and DELETE refuses the last user', async () => {
    const { app } = makeAuthedApp();
    const t = ((await (await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'secret' }) })).json()).token) as string;
    const h = { authorization: `Bearer ${t}`, 'content-type': 'application/json' };
    const created = await app.request('/users', { method: 'POST', headers: h, body: JSON.stringify({ username: 'bob', password: 'bobsecret' }) });
    expect(created.status).toBe(201);
    const dup = await app.request('/users', { method: 'POST', headers: h, body: JSON.stringify({ username: 'bob', password: 'bobsecret' }) });
    expect(dup.status).toBe(409);
    // delete bob ok, then deleting the remaining last user (alice) is refused
    const bobId = (await created.json()).id as number;
    expect((await app.request(`/users/${bobId}`, { method: 'DELETE', headers: { authorization: `Bearer ${t}` } })).status).toBe(200);
    const aliceId = (await (await app.request('/users', { headers: { authorization: `Bearer ${t}` } })).json())[0].id;
    expect((await app.request(`/users/${aliceId}`, { method: 'DELETE', headers: { authorization: `Bearer ${t}` } })).status).toBe(400);
  });

  it('POST /users enforces a password policy and validates the body (400, not 500/409)', async () => {
    const { app } = makeAuthedApp();
    const t = ((await (await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'secret' }) })).json()).token) as string;
    const h = { authorization: `Bearer ${t}`, 'content-type': 'application/json' };
    // Sub-8-char password → 400 from the schema (previously accepted, creating a weak account).
    expect((await app.request('/users', { method: 'POST', headers: h, body: JSON.stringify({ username: 'weak', password: 'short' }) })).status).toBe(400);
    // Empty username → 400.
    expect((await app.request('/users', { method: 'POST', headers: h, body: JSON.stringify({ username: '', password: 'longenough' }) })).status).toBe(400);
    // No body at all → 400 (previously a destructure TypeError → 500).
    expect((await app.request('/users', { method: 'POST', headers: h })).status).toBe(400);
  });

  it('DELETE /users/:id with a non-numeric id is a 400, not a silent no-op success', async () => {
    const { app } = makeAuthedApp();
    const t = ((await (await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'secret' }) })).json()).token) as string;
    expect((await app.request('/users/abc', { method: 'DELETE', headers: { authorization: `Bearer ${t}` } })).status).toBe(400);
  });

  it('DELETE /users/:id wipes the user\'s brain conversations and push devices (no rowid-reuse leak)', async () => {
    const { app, users, brainStore, pushSubscriptions } = makeAuthedApp();
    const t = ((await (await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'secret' }) })).json()).token) as string;
    const bob = users.create('bob', 'pw');
    // Seed private brain data + a registered push device for bob.
    brainStore.createSession({ id: `brain-${bob.id}-x`, userId: bob.id, model: 'm' });
    brainStore.appendMessage({ id: 'm1', sessionId: `brain-${bob.id}-x`, parentId: null, role: 'user', content: { text: 'bob secret' } });
    pushSubscriptions.upsert(bob.id, { endpoint: 'https://push/bob', keys: { p256dh: 'p', auth: 'a' } });
    expect(brainStore.listSessions(bob.id).length).toBe(1);
    expect(pushSubscriptions.listForUsers([bob.id]).length).toBe(1);

    expect((await app.request(`/users/${bob.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${t}` } })).status).toBe(200);

    // The route MUST wire brainStore.removeForUser + pushSubscriptions.removeAllForUser — otherwise the
    // rows survive keyed to a rowid SQLite will reissue to the next-created user.
    expect(brainStore.listSessions(bob.id).length).toBe(0);
    expect(pushSubscriptions.listForUsers([bob.id]).length).toBe(0);
  });
});
