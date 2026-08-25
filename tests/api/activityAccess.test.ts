import { describe, it, expect } from 'vitest';
import { EventStore } from '../../src/store/eventStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { openDb } from '../../src/store/db.js';
import { UsageOriginStore } from '../../src/store/usageOriginStore.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const bob = users.create('bob', 'pw');
  const userProjects = new UserProjectStore(db);
  userProjects.assign(bob.id, 1);
  const events = new EventStore(db);
  events.record({ type: 'plugin', plugin: 'demo', kind: 'home', projectId: 1, data: 1 }, 1);
  events.record({ type: 'plugin', plugin: 'demo', kind: 'foreign', projectId: 2, data: 2 }, 2);
  events.record({ type: 'plugin', plugin: 'demo', kind: 'unscoped', projectId: null, data: 3 });
  const app = createServer({
    bus: new EventBus(), events, project: { id: 1, path: '/o' }, clock: new FakeClock(0),
    config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects,
  });
  return { app, events, db, adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const targets = async (app: ReturnType<typeof setup>['app'], tok: string) =>
  ((await (await app.request('/activity', auth(tok))).json()) as { target: string }[]).map((r) => r.target).sort();

describe('GET /activity tenancy filtering', () => {
  it('shows a non-admin only their projects\' events (no null-project leak)', async () => {
    const { app, bobTok } = setup();
    expect(await targets(app, bobTok)).toEqual(['home']);
  });

  it('shows an admin the whole timeline', async () => {
    const { app, adminTok } = setup();
    expect(await targets(app, adminTok)).toEqual(['foreign', 'home', 'unscoped']);
  });
});

// The pulse tile reports spend per person. Its numbers come from the usage_by_origin rollup ALONE —
// the only source of origin-attributed usage — and money is the one thing on the dashboard nobody
// double-checks by hand, so the aggregation is pinned here.
describe('GET /activity/pulse', () => {
  function setupPulse() {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const events = new EventStore(db);
    const usageOrigins = new UsageOriginStore(db);
    const app = createServer({
      bus: new EventBus(), events, project: { id: 1, path: '/o' }, clock: new FakeClock(0),
      config: new ConfigStore(db), users, projects: new ProjectStore(db), usageOrigins,
    });
    return { app, events, usageOrigins, users, tok: users.issueToken(admin.id), adminId: admin.id };
  }
  const usage = (over: Partial<{ input: number; output: number; total: number; cost: number | null }> = {}) =>
    ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.25, ...over });
  const pulse = async (app: ReturnType<typeof setupPulse>['app'], tok: string) =>
    (await (await app.request('/activity/pulse', auth(tok))).json()) as {
      people: { userId: number; tokens: number; cost: number | null; surfaces: string[]; turns: number }[];
      totals: { turns: number; tokens: number; cost: number | null }; spendAvailable: boolean;
    };

  it('adds up a person\'s turns across the surfaces they worked from', async () => {
    const { app, usageOrigins, tok, adminId } = setupPulse();
    const now = Date.now();
    usageOrigins.addTurn(adminId, { value: 'local', kind: 'local', trusted: true }, usage({ total: 100 }), now);
    usageOrigins.addTurn(adminId, { value: 'platform:discord', kind: 'platform', trusted: true }, usage({ total: 50 }), now);

    const body = await pulse(app, tok);
    const me = body.people.find((p) => p.userId === adminId)!;
    expect(me.tokens).toBe(150);
    expect(me.turns).toBe(2);
    // The rollup already carries where the turn came from, so no second table is consulted for this.
    expect(me.surfaces.sort()).toEqual(['cli', 'discord']);
  });

  it('keeps an unpriced turn distinct from a free one', async () => {
    const { app, usageOrigins, tok, adminId } = setupPulse();
    usageOrigins.addTurn(adminId, { value: 'local', kind: 'local', trusted: true }, usage({ cost: null }), Date.now());

    const body = await pulse(app, tok);
    // null means nobody priced it. Reporting $0 here would understate a real bill on the dashboard.
    expect(body.people.find((p) => p.userId === adminId)!.cost).toBeNull();
    expect(body.totals.cost).toBeNull();
  });

  it('still totals the priced turns when only some of them carry a price', async () => {
    const { app, usageOrigins, tok, adminId } = setupPulse();
    const now = Date.now();
    usageOrigins.addTurn(adminId, { value: 'local', kind: 'local', trusted: true }, usage({ cost: 1.5 }), now);
    usageOrigins.addTurn(adminId, { value: 'internal', kind: 'internal', trusted: true }, usage({ cost: null }), now);

    expect((await pulse(app, tok)).totals.cost).toBe(1.5);
  });

  it('says the rollup is available so the tile can tell zero from missing', async () => {
    const { app, tok } = setupPulse();
    expect((await pulse(app, tok)).spendAvailable).toBe(true);
  });
});

describe('GET /activity?target', () => {
  it('returns one target oldest-first', async () => {
    const { app, events, adminTok } = setup();
    events.record({ type: 'plugin', plugin: 'demo', kind: 'thread', projectId: 1, data: 1 }, 1);
    events.record({ type: 'plugin', plugin: 'demo', kind: 'thread', projectId: 1, data: 2 }, 1);
    events.record({ type: 'plugin', plugin: 'demo', kind: 'other', projectId: 1, data: 3 }, 1);
    const rows = (await (await app.request('/activity?target=thread', auth(adminTok))).json()) as { target: string; detail: string }[];
    expect(rows.map((row) => row.target)).toEqual(['thread', 'thread']);
    expect(rows.map((row) => JSON.parse(row.detail))).toEqual([1, 2]);
  });
});

// The team feed is the ONE deliberate exception to project scoping: everyone sees the same safe activity.
describe('GET /activity — the instance-wide team feed', () => {
  it('reaches a tenant even though it belongs to no project', async () => {
    const { app, events, bobTok } = setup();
    events.record({ type: 'activity', kind: 'turn', actorUserId: 1, surface: 'cli', target: 'brain-1', detail: 'opus' });
    const rows = await (await app.request('/activity', auth(bobTok))).json() as { type: string; surface: string; actor_label: string }[];

    const feed = rows.filter((r) => r.type === 'turn');
    expect(feed).toHaveLength(1);
    expect(feed[0]!.surface).toBe('cli');
    expect(feed[0]!.actor_label).toBe('admin');
  });

  it('still withholds every project-scoped event the tenant cannot reach', async () => {
    const { app, events, bobTok } = setup();
    events.record({ type: 'activity', kind: 'turn', actorUserId: 1, surface: 'cli', target: 'brain-1', detail: 'opus' });
    const rows = await (await app.request('/activity', auth(bobTok))).json() as { type: string; target: string }[];

    const visible = rows.map((r) => r.target);
    expect(visible).toContain('home');
    expect(visible).not.toContain('foreign');
    expect(visible).not.toContain('unscoped');
  });

  it('does not let a foreign row reach the instance by calling itself a turn', async () => {
    const { app, db, bobTok } = setup();
    db.prepare("UPDATE events SET type = 'turn' WHERE target = 'foreign'").run();
    const rows = (await (await app.request('/activity', auth(bobTok))).json()) as { project_id: number | null }[];
    expect(rows.map((r) => r.project_id)).not.toContain(2);
  });

  it('strips the session id from feed rows it hands to the team', async () => {
    const { app, events, bobTok } = setup();
    events.record({ type: 'activity', kind: 'turn', actorUserId: 1, surface: 'web', target: 'brain-1-private' });
    const rows = (await (await app.request('/activity', auth(bobTok))).json()) as { type: string }[];
    expect(rows.filter((r) => r.type === 'turn')).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('brain-1-private');
  });
});

describe('GET /activity/heatmap and /activity/presence', () => {
  it('reports hourly volume for the whole team', async () => {
    const { app, events, bobTok } = setup();
    events.record({ type: 'activity', kind: 'turn', actorUserId: 1, surface: 'web', target: 'brain-1' });
    events.record({ type: 'activity', kind: 'turn', actorUserId: 2, surface: 'cli', target: 'brain-2' });
    const rows = (await (await app.request('/activity/heatmap', auth(bobTok))).json()) as { day: string; hour: number; count: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
  });

  it('lists who was recently active, not only who is mid-turn', async () => {
    const { app, events, bobTok, adminTok } = setup();
    events.record({ type: 'activity', kind: 'turn', actorUserId: 2, surface: 'web', target: 'brain-2' });
    const rows = (await (await app.request('/activity/presence', auth(bobTok))).json()) as { label: string; working: boolean }[];
    expect(rows).toEqual([{ userId: 2, label: 'bob', username: 'bob', working: false, lastTs: expect.any(String) }]);
    expect((await (await app.request('/activity/presence', auth(adminTok))).json())).toHaveLength(1);
  });
});
