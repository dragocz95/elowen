import { describe, it, expect } from 'vitest';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { EventStore } from '../../src/store/eventStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { RefMissions, RefReadiness, RefTaskStore, refEventRow } from '../helpers/refStores.js';
import { UsageOriginStore } from '../../src/store/usageOriginStore.js';

// Two projects; bob assigned to #1. The activity timeline carries task/mission ids + statuses, so it
// must be scoped per-project — a tenant sees only their projects' events, never the whole daemon's.
function setup() {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const bob = users.create('bob', 'pw');
  const userProjects = new UserProjectStore(db);
  userProjects.assign(bob.id, 1);
  const tasks = new RefTaskStore(db);
  tasks.create({ id: 't1', project_id: 1, title: 'home task' });
  tasks.create({ id: 't2', project_id: 2, title: 'foreign task' });
  const events = new EventStore(db, () => [refEventRow]);
  // task events stamp their project internally; mission events get the project passed in (as the bus
  // subscriber does in bootstrap). A legacy event with no resolvable project stays null → admin-only.
  events.record({ type: 'task', taskId: 't1', status: 'open' });
  events.record({ type: 'task', taskId: 't2', status: 'open' });
  events.record({ type: 'mission', missionId: 'm-e1', state: 'active' }, 1);
  events.record({ type: 'mission', missionId: 'm-e2', state: 'active' }, 2);
  events.record({ type: 'task', taskId: 'gone', status: 'open' }); // unresolved → project_id null
  const app = createServer({
    tasks, taskRefs: new TaskRefs(db), readiness: new RefReadiness(db), missions: new RefMissions(db), bus: new EventBus(), events,
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects,
  });
  return { app, events, db, adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const targets = async (app: ReturnType<typeof setup>['app'], tok: string) =>
  ((await (await app.request('/activity', auth(tok))).json()) as { target: string }[]).map((r) => r.target).sort();

describe('GET /activity tenancy filtering', () => {
  it('shows a non-admin only their projects\' events (no null-project leak)', async () => {
    const { app, bobTok } = setup();
    expect(await targets(app, bobTok)).toEqual(['m-e1', 't1'].sort()); // not t2/m-e2 (project 2), not the null-project row
  });

  it('shows an admin the whole timeline', async () => {
    const { app, adminTok } = setup();
    expect(await targets(app, adminTok)).toEqual(['gone', 'm-e1', 'm-e2', 't1', 't2'].sort());
  });
});

// The pulse tile reports spend per person. Its numbers come from the usage_by_origin rollup ALONE —
// the only source of origin-attributed usage — and money is the one thing on the dashboard nobody
// double-checks by hand, so the aggregation is pinned here.
describe('GET /activity/pulse', () => {
  function setupPulse() {
    const db = openPluginTablesDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const events = new EventStore(db, () => [refEventRow]);
    const usageOrigins = new UsageOriginStore(db);
    const app = createServer({
      tasks: new RefTaskStore(db), taskRefs: new TaskRefs(db), readiness: new RefReadiness(db),
      missions: new RefMissions(db), bus: new EventBus(), events,
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db),
      usageOrigins,
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

describe('GET /activity?target — per-task conversation feed', () => {
  function setupTask() {
    const db = openPluginTablesDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const tasks = new RefTaskStore(db);
    tasks.create({ id: 'tk', project_id: 1, title: 'Task' });
    tasks.create({ id: 'other', project_id: 1, title: 'Other' });
    const events = new EventStore(db, () => [refEventRow]);
    events.record({ type: 'decision', taskId: 'tk', kind: 'prompt', question: 'run it?', outcome: 'approved', rationale: 'safe', confidence: 0.9 });
    events.record({ type: 'task', taskId: 'tk', status: 'in_progress' });
    events.record({ type: 'review', missionId: 'm-x', taskId: 'tk', approve: false, rationale: 'redo' });
    events.record({ type: 'decision', taskId: 'other', kind: 'prompt', question: 'nope', outcome: 'approved', rationale: 'x', confidence: 0.5 });
    const app = createServer({
      tasks, taskRefs: new TaskRefs(db), readiness: new RefReadiness(db), missions: new RefMissions(db), bus: new EventBus(), events,
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db),
    });
    return { app, tok: users.issueToken(admin.id) };
  }

  it('returns one task\'s events oldest-first, scoped to that target', async () => {
    const { app, tok } = setupTask();
    const rows = (await (await app.request('/activity?target=tk', auth(tok))).json()) as { type: string; target: string }[];
    expect(rows.every((r) => r.target === 'tk')).toBe(true);       // not 'other'
    expect(rows.map((r) => r.type)).toEqual(['decision', 'task', 'review']); // id ASC (chronological)
  });
});

describe('EventStore.record project stamping', () => {
  it('honors a passed-in project for non-task events, else falls back to the task lookup', () => {
    const db = openPluginTablesDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
    const tasks = new RefTaskStore(db);
    tasks.create({ id: 't1', project_id: 1, title: 'x' });
    const events = new EventStore(db, () => [refEventRow]);
    events.record({ type: 'mission', missionId: 'm-e1', state: 'active' }, 7); // explicit
    events.record({ type: 'task', taskId: 't1', status: 'open' });             // fallback → 1
    events.record({ type: 'mission', missionId: 'm-e2', state: 'active' });    // no arg, not a task → null
    const rows = events.list();
    expect(rows.find((r) => r.target === 'm-e1')!.project_id).toBe(7);
    expect(rows.find((r) => r.target === 't1')!.project_id).toBe(1);
    expect(rows.find((r) => r.target === 'm-e2')!.project_id).toBeNull();
  });
});

// The team feed is the ONE deliberate exception to project scoping: Filip's decision that everyone sees
// the same activity. It is safe only because of what the row does NOT carry -- no message text, no
// conversation titles, no commands, no paths. Everything else must stay fail-closed for a tenant.
describe('GET /activity — the instance-wide team feed', () => {
  it('reaches a tenant even though it belongs to no project', async () => {
    const { app, events, bobTok } = setup();
    events.record({ type: 'activity', kind: 'turn', actorUserId: 1, surface: 'cli', target: 'brain-1', detail: 'opus' });
    const rows = await (await app.request('/activity', auth(bobTok))).json() as { type: string; surface: string; actor_label: string }[];

    const feed = rows.filter((r) => r.type === 'turn');
    expect(feed).toHaveLength(1);
    expect(feed[0]!.surface).toBe('cli');
    expect(feed[0]!.actor_label).toBe('admin'); // resolved by JOIN at read time, username as fallback
  });

  it('still withholds every project-scoped event the tenant cannot reach', async () => {
    const { app, events, bobTok } = setup();
    events.record({ type: 'activity', kind: 'turn', actorUserId: 1, surface: 'cli', target: 'brain-1', detail: 'opus' });
    const rows = await (await app.request('/activity', auth(bobTok))).json() as { type: string; target: string }[];

    const targets = rows.map((r) => r.target);
    expect(targets).toContain('t1'); // bob's own project
    expect(targets).not.toContain('t2'); // foreign project
    expect(targets).not.toContain('m-e2');
    expect(targets).not.toContain('gone'); // unresolved project stays admin-only
  });

  // A plugin event-row resolver can return any `type` it likes. If the feed were recognised by type
  // name alone, a row calling itself 'turn' would reach the whole instance past project scoping.
  it('does not let a foreign row reach the instance by calling itself a turn', async () => {
    const { app, db, bobTok } = setup();
    db.prepare("UPDATE events SET type = 'turn' WHERE target = 't2'").run();

    const rows = (await (await app.request('/activity', auth(bobTok))).json()) as { project_id: number | null }[];

    // Project 2 is not bob's, and claiming the feed's type name must not change that. Asserted on the
    // project rather than on `target`, which feed rows no longer carry -- that would pass either way.
    expect(rows.map((r) => r.project_id)).not.toContain(2);
  });

  // The tile never renders it, but the JSON used to carry every account's session and channel ids.
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

    // Both turns land in the same hour bucket, counted per turn -- the feed's folding does not apply.
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
  });

  it('lists who was recently active, not only who is mid-turn', async () => {
    const { app, events, bobTok, adminTok } = setup();
    events.record({ type: 'activity', kind: 'turn', actorUserId: 2, surface: 'web', target: 'brain-2' });

    const rows = (await (await app.request('/activity/presence', auth(bobTok))).json()) as { label: string; working: boolean }[];

    // Nobody is running a turn in this harness, so a presence line built only from live sessions would
    // be empty -- and empty most of the day on a real instance too.
    // The rail draws faces, so presence carries the username and (when set) the avatar handle; an
    // account with no picture sends no `avatar` key at all.
    expect(rows).toEqual([{ userId: 2, label: 'bob', username: 'bob', working: false, lastTs: expect.any(String) }]);
    expect((await (await app.request('/activity/presence', auth(adminTok))).json())).toHaveLength(1);
  });
});
