import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';

function makeAuthedApp() {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db); users.create('alice', 'secret');
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db),
    bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users,
  });
  return { app, users };
}

describe('auth', () => {
  it('POST /auth/login returns a token for valid creds, 401 otherwise', async () => {
    const { app } = makeAuthedApp();
    const ok = await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'secret' }) });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(typeof body.token).toBe('string');
    expect(body.user.username).toBe('alice');
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
    const created = await app.request('/users', { method: 'POST', headers: h, body: JSON.stringify({ username: 'bob', password: 'pw' }) });
    expect(created.status).toBe(201);
    const dup = await app.request('/users', { method: 'POST', headers: h, body: JSON.stringify({ username: 'bob', password: 'pw' }) });
    expect(dup.status).toBe(409);
    // delete bob ok, then deleting the remaining last user (alice) is refused
    const bobId = (await created.json()).id as number;
    expect((await app.request(`/users/${bobId}`, { method: 'DELETE', headers: { authorization: `Bearer ${t}` } })).status).toBe(200);
    const aliceId = (await (await app.request('/users', { headers: { authorization: `Bearer ${t}` } })).json())[0].id;
    expect((await app.request(`/users/${aliceId}`, { method: 'DELETE', headers: { authorization: `Bearer ${t}` } })).status).toBe(400);
  });
});
