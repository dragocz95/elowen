import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { openDb } from '../../src/store/db.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen',?)").run(process.cwd());
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user → is_admin
  const bob = users.create('bob', 'pw');
  const adminTok = users.issueToken(admin.id);
  const bobTok = users.issueToken(bob.id);
  const projects = new ProjectStore(db);
  const config = new ConfigStore(db);
  const bus = new EventBus();
  const app = createServer({
    bus,
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: process.cwd() }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config,
    users, projects, userProjects: new UserProjectStore(db),
    // No plugins: what is measured here is the daemon's OWN gate over /projects, /activity and /events.
    // The same gate seen through the plugin-served task surface moved with those routes to the plugin
    // registry (tests/work-projectAccess.test.ts there).
  });
  return { app, adminTok, bobTok, bob };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('project access gating', () => {
  it('admin sees all projects; an unassigned non-admin sees none', async () => {
    const { app, adminTok, bobTok } = setup();
    expect(((await (await app.request('/projects', auth(adminTok))).json()) as unknown[]).length).toBe(1);
    expect(((await (await app.request('/projects', auth(bobTok))).json()) as unknown[]).length).toBe(0);
  });

  it('a non-admin cannot manage assignments or create projects (no privilege escalation)', async () => {
    const { app, bobTok, bob } = setup();
    expect((await app.request(`/users/${bob.id}/projects`, post(bobTok, { projectId: 1 }))).status).toBe(403);
    expect((await app.request('/projects', post(bobTok, { slug: 'x', path: '/x' }))).status).toBe(403);
  });

  it('also gates the activity log and the live event stream (no cross-tenant leak)', async () => {
    const { app, adminTok, bobTok } = setup();
    expect((await app.request('/activity', auth(bobTok))).status).toBe(403);
    expect((await app.request('/events', auth(bobTok))).status).toBe(403); // 403 before the SSE stream opens
    expect((await app.request('/activity', auth(adminTok))).status).toBe(200);
  });

  it('refuses to delete the admin user (no adminless lockout / silent re-election)', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/users/1', { method: 'DELETE', headers: { authorization: `Bearer ${adminTok}` } })).status).toBe(400);
  });
});
