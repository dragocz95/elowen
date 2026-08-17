import { describe, it, expect } from 'vitest';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { UsageOriginStore } from '../../src/store/usageOriginStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { RefMissions, RefReadiness, RefTaskStore } from '../helpers/refStores.js';

const AT = Date.UTC(2026, 7, 17, 10, 0);
const ip = (value: string, trusted = true) => ({ value, kind: 'ip' as const, trusted });
const usage = (total: number, cost: number | null = null) => ({
  input: total, output: 0, cacheRead: 0, cacheWrite: 0, total, cost,
});

function setup() {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user → is_admin
  const bob = users.create('bob', 'pw');
  const userProjects = new UserProjectStore(db);
  // Bob is a fully assigned, non-admin member: without this the coarse project pre-filter in
  // src/api/middleware.ts would 403 him before the route runs, and the guard test below would pass even
  // with the route's own admin check deleted.
  userProjects.assign(bob.id, 1);
  const usageOrigins = new UsageOriginStore(db);
  const app = createServer({
    tasks: new RefTaskStore(db), readiness: new RefReadiness(db), missions: new RefMissions(db), bus: new EventBus(),
    engine: { disengage: async () => {} } as never, tmux: new FakeTmuxDriver(),
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects,
    brainStore: new BrainStore(db), usageOrigins,
  });
  return {
    app, db, usageOrigins, adminId: admin.id, bobId: bob.id,
    adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id),
  };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{}' });

describe('GET /usage/by-origin', () => {
  it('forbids a non-admin with a perfectly valid token (403, not an empty list)', async () => {
    const { app, usageOrigins, bobId, bobTok } = setup();
    usageOrigins.addTurn(bobId, ip('203.0.113.7'), usage(100), AT);

    const res = await app.request('/usage/by-origin', auth(bobTok));
    // Asserted as a STATUS on purpose: a filter that merely returned bob's own rows would look fine on a
    // data assertion while still telling him that IP addresses are being recorded, and would leak every
    // other account's the moment someone "generalized" it.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('reports who spent what, from where, with the tracking window', async () => {
    const { app, usageOrigins, adminId, bobId, adminTok } = setup();
    usageOrigins.addTurn(adminId, ip('203.0.113.7'), usage(1000, 2), AT);
    usageOrigins.addTurn(bobId, ip('198.51.100.44', false), usage(400), AT);

    const body = await (await app.request('/usage/by-origin', auth(adminTok))).json();
    expect(body.trackingSince).toBe('2026-08-17');
    expect(body.group).toBe('pair');
    expect(body.rows.map((r: { username: string; origin: string; tokens: number; trusted: boolean; costSource: string }) =>
      [r.username, r.origin, r.tokens, r.trusted, r.costSource])).toEqual([
      ['admin', '203.0.113.7', 1000, true, 'provider_reported'],
      // Unverified and uncosted: the row says so instead of showing a confident $0.
      ['bob', '198.51.100.44', 400, false, 'unavailable'],
    ]);
  });

  it('groups by user or by origin on request', async () => {
    const { app, usageOrigins, adminId, adminTok } = setup();
    usageOrigins.addTurn(adminId, ip('203.0.113.7'), usage(100), AT);
    usageOrigins.addTurn(adminId, ip('198.51.100.44'), usage(200), AT);

    const byUser = await (await app.request('/usage/by-origin?group=user', auth(adminTok))).json();
    expect(byUser.rows).toHaveLength(1);
    expect(byUser.rows[0]).toMatchObject({ username: 'admin', tokens: 300, origins: 2, origin: null });

    const byOrigin = await (await app.request('/usage/by-origin?group=origin', auth(adminTok))).json();
    expect(byOrigin.rows.map((r: { origin: string; userId: number | null }) => [r.origin, r.userId]))
      .toEqual([['198.51.100.44', null], ['203.0.113.7', null]]);
  });

  it('503s rather than answering an empty list when the store is unwired', async () => {
    const db = openPluginTablesDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const app = createServer({
      tasks: new RefTaskStore(db), readiness: new RefReadiness(db), missions: new RefMissions(db), bus: new EventBus(),
      engine: { disengage: async () => {} } as never, tmux: new FakeTmuxDriver(),
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config: new ConfigStore(db),
      users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    });
    // "No rows" and "not recording" are different answers, and only one of them means an admin should
    // go looking at the wiring.
    expect((await app.request('/usage/by-origin', auth(users.issueToken(admin.id)))).status).toBe(503);
  });
});

describe('POST /usage/reset', () => {
  it('clears the caller\'s origin rollup along with the rest of their usage', async () => {
    const { app, db, usageOrigins, adminId, bobId, adminTok } = setup();
    usageOrigins.recordRequest('brain-1', adminId, ip('203.0.113.7'), AT);
    usageOrigins.addTurn(adminId, ip('203.0.113.7'), usage(1000), AT);
    usageOrigins.addTurn(bobId, ip('198.51.100.44'), usage(400), AT);

    const body = await (await app.request('/usage/reset', post(adminTok))).json();
    expect(body).toMatchObject({ ok: true, originsCleared: 1 });
    // Leaving this behind is what made the drawer keep reporting spend the rest of Stats had forgotten.
    const rows = db.prepare('SELECT user_id FROM usage_by_origin').all();
    expect(rows).toEqual([{ user_id: bobId }]);
    expect(db.prepare('SELECT COUNT(*) c FROM brain_session_origins').get()).toEqual({ c: 0 });
  });
});
