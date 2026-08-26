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
import { MemoryStore } from '../../src/store/memoryStore.js';
import { BrainStore } from '../../src/store/brainStore.js';

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
// The feed says what a turn RAN, which is read by parsing transcript bodies — the only place tool calls
// exist. Two things matter here: that the tools arrive, and that resolving them does not leak the session
// id they were looked up by.
describe('GET /activity tool attribution', () => {
  function setupTools() {
    const db = openDb(':memory:');
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const events = new EventStore(db);
    const brainStore = new BrainStore(db);
    const sessionId = 'brain-1';
    brainStore.createSession({ id: sessionId, userId: admin.id, title: 'work', workDir: '/o', model: 'claude-opus-5' });
    events.record({ type: 'activity', kind: 'turn', actorUserId: admin.id, surface: 'web', target: sessionId });
    const app = createServer({
      bus: new EventBus(), events, project: { id: 1, path: '/o' }, clock: new FakeClock(0),
      config: new ConfigStore(db), users, projects: new ProjectStore(db), brainStore,
    });
    return { app, brainStore, sessionId, tok: users.issueToken(admin.id) };
  }
  const appendTools = (store: BrainStore, sessionId: string, id: string, names: string[]) =>
    store.appendMessage({
      id, sessionId, parentId: null, role: 'assistant',
      content: { role: 'assistant', content: names.map((name) => ({ type: 'toolCall', id: `${id}-${name}`, name })) },
    });
  const feed = async (app: ReturnType<typeof setupTools>['app'], tok: string) =>
    (await (await app.request('/activity', auth(tok))).json()) as
      { type: string; target: string; tools?: { name: string; count: number }[] }[];

  it('reports the tools a turn ran, busiest first', async () => {
    const { app, brainStore, sessionId, tok } = setupTools();
    appendTools(brainStore, sessionId, 'm1', ['Read', 'Read', 'Bash']);
    appendTools(brainStore, sessionId, 'm2', ['Read']);

    const [row] = await feed(app, tok);
    expect(row!.tools).toEqual([{ name: 'Read', count: 3 }, { name: 'Bash', count: 1 }]);
  });

  it('never ships the session id it resolved those tools by', async () => {
    const { app, brainStore, sessionId, tok } = setupTools();
    appendTools(brainStore, sessionId, 'm1', ['Bash']);

    const [row] = await feed(app, tok);
    // `target` is an internal handle. Looking tools up by it must not turn it into a shipped field.
    expect(row!.target).toBe('');
    expect(JSON.stringify(row)).not.toContain(sessionId);
  });

  it('leaves a turn with no tool calls alone rather than inventing an empty list entry', async () => {
    const { app, brainStore, sessionId, tok } = setupTools();
    // A plain answer with no tools at all.
    brainStore.appendMessage({
      id: 'm1', sessionId, parentId: null, role: 'assistant',
      content: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    });

    const [row] = await feed(app, tok);
    expect(row!.tools).toEqual([]);
  });

  it('picks up a tool the moment it is recorded, without waiting out a cache window', async () => {
    const { app, brainStore, sessionId, tok } = setupTools();
    appendTools(brainStore, sessionId, 'm1', ['Read']);
    expect((await feed(app, tok))[0]!.tools).toEqual([{ name: 'Read', count: 1 }]);

    // The read is cached, but keyed on the newest message rowid rather than on a clock — so new work
    // appears in the very next request instead of after a TTL nobody can see.
    appendTools(brainStore, sessionId, 'm2', ['Bash']);

    const [row] = await feed(app, tok);
    expect(row!.tools).toEqual([{ name: 'Read', count: 1 }, { name: 'Bash', count: 1 }]);
  });

  it('survives a transcript row it cannot parse', async () => {
    const { app, brainStore, sessionId, tok } = setupTools();
    appendTools(brainStore, sessionId, 'm1', ['Bash']);
    // One corrupt row must not take the whole timeline down with it.
    brainStore.appendMessage({ id: 'm2', sessionId, parentId: null, role: 'assistant', content: 'not an object' });

    const [row] = await feed(app, tok);
    expect(row!.tools).toEqual([{ name: 'Bash', count: 1 }]);
  });
});

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
      people: {
        userId: number; tokens: number; cost: number | null; surfaces: string[]; turns: number;
        cacheHitPct: number | null; memoryHits: number; title: string; hoursToday: number[];
        activeToday: boolean;
        month: {
          turns: number; tokens: number; cost: number | null; cacheHitPct: number | null;
          memoryHits: number; surfaces: string[]; days: number[];
        };
      }[];
      totals: {
        turns: number; tokens: number; cost: number | null; activePeople: number;
        runningAgents: number; memoryHits: number; cacheHitPct: number | null;
      };
      month: {
        from: string; days: number; tokens: number; cost: number | null;
        surfaces: { surface: string; turns: number; tokens: number; cost: number | null }[];
        context: { cacheRead: number; input: number; cacheWrite: number; output: number };
      };
      spendAvailable: boolean;
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

  it('weighs the cache ratio by context rather than averaging the rows', async () => {
    const { app, usageOrigins, tok, adminId } = setupPulse();
    const now = Date.now();
    // One big warm turn and one small cold one. Averaging the two ratios would say ~50 %; weighting by
    // context says ~90 %, which is what the money actually did.
    usageOrigins.addTurn(adminId, { value: 'local', kind: 'local', trusted: true },
      { ...usage(), input: 100, cacheRead: 900, total: 1000 }, now);
    usageOrigins.addTurn(adminId, { value: 'internal', kind: 'internal', trusted: true },
      { ...usage(), input: 100, cacheRead: 0, total: 100 }, now);

    const body = await pulse(app, tok);
    expect(body.people.find((p) => p.userId === adminId)!.cacheHitPct).toBeCloseTo(81.8, 1);
    expect(body.totals.cacheHitPct).toBeCloseTo(81.8, 1);
  });

  it('leaves the cache ratio null when nothing ran, rather than reporting a cold zero', async () => {
    const { app, tok, users } = setupPulse();
    const idle = users.create('idle', 'pw');
    // Somebody with no turns today has no ratio to report. A confident 0 % would read as a cache that
    // never hits, which is a different — and alarming — claim than "no measurement".
    const body = await pulse(app, tok);
    expect(body.people.find((p) => p.userId === idle.id)?.cacheHitPct ?? null).toBeNull();
    expect(body.totals.cacheHitPct).toBeNull();
  });

  it('keeps somebody who worked earlier in the month without counting them as here today', async () => {
    const { app, usageOrigins, tok, adminId, users } = setupPulse();
    const earlier = users.create('earlier', 'pw');
    usageOrigins.addTurn(adminId, { value: 'local', kind: 'local', trusted: true },
      usage({ total: 100 }), Date.now());
    usageOrigins.addTurn(earlier.id, { value: 'local', kind: 'local', trusted: true },
      usage({ total: 900 }), Date.now() - 5 * 86_400_000);

    const body = await pulse(app, tok);
    const them = body.people.find((p) => p.userId === earlier.id)!;
    // They belong on the ring, which divides a month...
    expect(them.month.tokens).toBe(900);
    expect(body.month.tokens).toBe(1000);
    // ...but they did nothing today, and the gauge above the ring means exactly that. Deriving it from
    // the length of `people` — as it did while the tile was a single window — would overstate it.
    expect(them.tokens).toBe(0);
    expect(them.activeToday).toBe(false);
    expect(body.totals.activePeople).toBe(1);
  });

  it('collapses every web caller into one surface instead of a slice per IP address', async () => {
    const { app, usageOrigins, tok, adminId } = setupPulse();
    const now = Date.now();
    // The rollup keys a browser turn by the caller's IP, so a month of web work is dozens of distinct
    // origins. Drawn raw, the channel ring would be a haze of unnamed slivers.
    usageOrigins.addTurn(adminId, { value: '172.68.213.108', kind: 'ip', trusted: true },
      usage({ total: 100, cost: 1 }), now);
    usageOrigins.addTurn(adminId, { value: '172.71.15.88', kind: 'ip', trusted: true },
      usage({ total: 50, cost: 0.5 }), now);
    usageOrigins.addTurn(adminId, { value: 'local', kind: 'local', trusted: true },
      usage({ total: 30, cost: 0.25 }), now);

    const { month } = await pulse(app, tok);
    const web = month.surfaces.find((s) => s.surface === 'web')!;
    expect(web.tokens).toBe(150);
    expect(web.cost).toBe(1.5);
    expect(web.turns).toBe(2);
    // ...and the CLI stays its own slice rather than being folded in with it.
    expect(month.surfaces.find((s) => s.surface === 'cli')!.tokens).toBe(30);
    expect(month.surfaces.filter((s) => s.surface === 'web')).toHaveLength(1);
  });

  it('splits the month by kind of token, not just by how many there were', async () => {
    const { app, usageOrigins, tok, adminId } = setupPulse();
    // Warm reads bill at a fraction of fresh input, so this split is the difference between a big month
    // and an expensive one. A single total cannot say which this was.
    usageOrigins.addTurn(adminId, { value: 'local', kind: 'local', trusted: true },
      { input: 100, output: 20, cacheRead: 900, cacheWrite: 40, total: 1060, cost: 1 }, Date.now());

    const { month } = await pulse(app, tok);
    expect(month.context).toEqual({ cacheRead: 900, input: 100, cacheWrite: 40, output: 20 });
  });

  it('counts a delegated session as a running agent, not as a person at a keyboard', async () => {
    const db = openDb(':memory:');
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const events = new EventStore(db);
    const brain = {
      presence: () => [
        { userId: admin.id, sessionId: `brain-${admin.id}`, title: 'Real work' },
        { userId: admin.id, sessionId: 'brain-ch-subagent-abc', title: 'Delegated brief' },
      ],
    } as never;
    const app = createServer({
      bus: new EventBus(), events, project: { id: 1, path: '/o' }, clock: new FakeClock(0),
      config: new ConfigStore(db), users, projects: new ProjectStore(db),
      usageOrigins: new UsageOriginStore(db), brain,
    });
    const body = await pulse(app, users.issueToken(admin.id));

    expect(body.totals.runningAgents).toBe(1);
    // The sub-agent must not double the owner's row, and must not steal the title of their own turn.
    expect(body.people.filter((p) => p.userId === admin.id)).toHaveLength(1);
    expect(body.people.find((p) => p.userId === admin.id)!.title).toBe('Real work');
  });

  it('reports the memories each person recalled today', async () => {
    const db = openDb(':memory:');
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const memoryStore = new MemoryStore(db);
    const made = memoryStore.add(admin.id, { body: 'a fact' }, 'test', 'seed');
    memoryStore.markUsed(admin.id, [made.id]);
    const app = createServer({
      bus: new EventBus(), events: new EventStore(db), project: { id: 1, path: '/o' },
      clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db),
      usageOrigins: new UsageOriginStore(db), memoryStore,
    });
    const body = await pulse(app, users.issueToken(admin.id));

    expect(body.people.find((p) => p.userId === admin.id)!.memoryHits).toBe(1);
    expect(body.totals.memoryHits).toBe(1);
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
