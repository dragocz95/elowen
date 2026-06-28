import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const bob = users.create('bob', 'pw');
  const avatarsDir = mkdtempSync(join(tmpdir(), 'orca-av-'));
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db), avatarsDir, avatarSecret: 'test-avatar-secret',
  });
  return { app, bob, adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (t: string, body: unknown) => ({ method: 'PUT', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('PATCH /auth/me — self-service profile', () => {
  it('updates name, email and a valid preferred default executor', async () => {
    const { app, bobTok } = setup();
    const res = await app.request('/auth/me', patch(bobTok, { name: 'Bob B', email: 'bob@x.io', default_exec: 'sonnet' }));
    expect(res.status).toBe(200);
    const u = await res.json();
    expect(u).toMatchObject({ name: 'Bob B', email: 'bob@x.io', default_exec: 'sonnet' });
  });

  it('rejects a default executor the user is not allowed to run', async () => {
    const { app, bobTok } = setup();
    expect((await app.request('/auth/me', patch(bobTok, { default_exec: 'bogus/model' }))).status).toBe(400);
  });
});

describe('POST /auth/me/password — self-service password change', () => {
  it('changes the password when the current one is correct, and the new one then logs in', async () => {
    const { app, bobTok } = setup();
    const res = await app.request('/auth/me/password', post(bobTok, { currentPassword: 'pw', newPassword: 'brandnewpw' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // old password no longer logs in; the new one does
    expect((await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'pw' }) })).status).toBe(401);
    expect((await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'brandnewpw' }) })).status).toBe(200);
  });
  it('rejects a wrong current password with 403 (not 401 — the session is valid) and leaves it unchanged', async () => {
    const { app, bobTok } = setup();
    // 403, not 401: the bearer is valid, so the web client must not treat this as session expiry and
    // log the user out — a wrong current password is a refused action, not an auth failure.
    expect((await app.request('/auth/me/password', post(bobTok, { currentPassword: 'nope', newPassword: 'brandnewpw' }))).status).toBe(403);
    expect((await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'pw' }) })).status).toBe(200);
  });
  it('rejects a too-short new password with 400', async () => {
    const { app, bobTok } = setup();
    expect((await app.request('/auth/me/password', post(bobTok, { currentPassword: 'pw', newPassword: 'short' }))).status).toBe(400);
  });
  it('requires a bearer token', async () => {
    const { app } = setup();
    expect((await app.request('/auth/me/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'pw', newPassword: 'brandnewpw' }) })).status).toBe(401);
  });
});

describe('avatar upload + serve', () => {
  it('stores an uploaded avatar and serves it back', async () => {
    const { app, bob, bobTok } = setup();
    const fd = new FormData();
    fd.append('avatar', new File([new Uint8Array([1, 2, 3, 4])], 'me.png', { type: 'image/png' }));
    const up = await app.request('/auth/me/avatar', { method: 'POST', headers: { authorization: `Bearer ${bobTok}` }, body: fd });
    expect(up.status).toBe(200);
    expect((await up.json()).avatar).toBe(`${bob.id}.png`);

    const got = await app.request(`/users/${bob.id}/avatar`, auth(bobTok));
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
  });

  it('rejects a non-image upload', async () => {
    const { app, bobTok } = setup();
    const fd = new FormData();
    fd.append('avatar', new File([new Uint8Array([1, 2, 3])], 'x.txt', { type: 'text/plain' }));
    expect((await app.request('/auth/me/avatar', { method: 'POST', headers: { authorization: `Bearer ${bobTok}` }, body: fd })).status).toBe(415);
  });

  it('404s when a user has no avatar', async () => {
    const { app, bob, bobTok } = setup();
    expect((await app.request(`/users/${bob.id}/avatar`, auth(bobTok))).status).toBe(404);
  });
});

describe('avatar signed URL (W2 — no long-lived token in the <img> src)', () => {
  async function uploadAvatar(app: ReturnType<typeof setup>['app'], bobTok: string) {
    const fd = new FormData();
    fd.append('avatar', new File([new Uint8Array([1, 2, 3, 4])], 'me.png', { type: 'image/png' }));
    await app.request('/auth/me/avatar', { method: 'POST', headers: { authorization: `Bearer ${bobTok}` }, body: fd });
  }

  it('mints a signed URL (authenticated) and serves the avatar with NO session token in the path', async () => {
    const { app, bob, bobTok } = setup();
    await uploadAvatar(app, bobTok);
    const minted = await app.request(`/users/${bob.id}/avatar/url`, auth(bobTok));
    expect(minted.status).toBe(200);
    const { url } = await minted.json() as { url: string };
    expect(url).toMatch(/^\/users\/\d+\/avatar\?exp=\d+&sig=[0-9a-f]+$/);
    expect(url).not.toContain('token='); // the whole point: no long-lived token in the URL
    // The signed link works WITHOUT any bearer/token header (an <img> can't set headers).
    const got = await app.request(url);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
  });

  it('rejects a tampered signature and an expired link', async () => {
    const { app, bob, bobTok } = setup();
    await uploadAvatar(app, bobTok);
    const { url } = await (await app.request(`/users/${bob.id}/avatar/url`, auth(bobTok))).json() as { url: string };
    // Flip the last sig char → invalid HMAC → 403, no bytes served.
    const tampered = url.slice(0, -1) + (url.endsWith('a') ? 'b' : 'a');
    expect((await app.request(tampered)).status).toBe(403);
    // A past `exp` is rejected even with an otherwise well-formed sig.
    expect((await app.request(`/users/${bob.id}/avatar?exp=1&sig=deadbeef`)).status).toBe(403);
  });

  it('still requires auth for an unsigned avatar request', async () => {
    const { app, bob, bobTok } = setup();
    await uploadAvatar(app, bobTok);
    expect((await app.request(`/users/${bob.id}/avatar`)).status).toBe(401); // no sig, no bearer
  });
});

describe('PUT /config is admin-only', () => {
  it('forbids a non-admin and allows the admin', async () => {
    const { app, adminTok, bobTok } = setup();
    expect((await app.request('/config', put(bobTok, { allowedExecs: ['sonnet'] }))).status).toBe(403);
    expect((await app.request('/config', put(adminTok, { allowedExecs: ['sonnet'] }))).status).toBe(200);
  });
});
