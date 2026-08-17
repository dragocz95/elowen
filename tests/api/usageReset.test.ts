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
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { RefMissions, RefReadiness, RefTaskStore, RefTaskUsage } from '../helpers/refStores.js';

const usage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165, reasoning: 0, costUsd: 0.5, currency: 'USD', costSource: 'provider_reported' as const };

function setup() {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user → is_admin
  const bob = users.create('bob', 'pw');
  const tmux = new FakeTmuxDriver();
  const taskUsage = new RefTaskUsage(db);
  const brainStore = new BrainStore(db);
  const app = createServer({
    tasks: new RefTaskStore(db), readiness: new RefReadiness(db), missions: new RefMissions(db), bus: new EventBus(),
    engine: { disengage: async () => {} } as never, tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db), taskUsage, brainStore,
  });
  return { app, db, taskUsage, brainStore, adminId: admin.id, adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id) };
}
const auth = (t: string | null) => ({ headers: t ? { authorization: `Bearer ${t}` } : {} });
const post = (t: string | null) => ({ method: 'POST', headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), 'content-type': 'application/json' }, body: '{}' });

describe('GET /usage/by-model', () => {
  it('returns the persisted aggregate per exec from the DB', async () => {
    const { app, taskUsage, adminTok } = setup();
    taskUsage.record('t1', 1, 'sonnet', usage);
    taskUsage.record('t2', 1, 'sonnet', usage);
    const res = await app.request('/usage/by-model', auth(adminTok));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 'sonnet', exec: 'sonnet', program: 'claude-code', provider: null, model: 'sonnet' });
    expect(body[0].usage.total).toBe(330);
    expect(body[0].usage.costUsd).toBe(1);
  });

  it('narrows to a ?from=&to= window', async () => {
    const { app, db, taskUsage, adminTok } = setup();
    taskUsage.record('old', 1, 'sonnet', usage);
    db.prepare("UPDATE task_usage SET captured_at = '2020-01-01 00:00:00' WHERE task_id = 'old'").run();
    taskUsage.record('recent', 1, 'sonnet', usage);
    const res = await app.request('/usage/by-model?from=2026-06-01T00:00:00.000Z', auth(adminTok));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].usage.total).toBe(165); // only 'recent', 'old' excluded by the window
  });

  it('ignores a malformed ?from= (no 400, unfiltered result)', async () => {
    const { app, taskUsage, adminTok } = setup();
    taskUsage.record('t1', 1, 'sonnet', usage);
    const res = await app.request('/usage/by-model?from=notadate', auth(adminTok));
    expect(res.status).toBe(200);
    expect((await res.json())[0].usage.total).toBe(165);
  });
});

describe('GET /usage/by-day', () => {
  it('returns daily buckets for the caller (admin sees all projects)', async () => {
    const { app, taskUsage, adminTok } = setup();
    taskUsage.record('t1', 1, 'sonnet', usage);
    taskUsage.record('t2', 1, 'opus', usage); // same day → merges into one bucket
    const res = await app.request('/usage/by-day', auth(adminTok));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].tokens).toBe(330);
    expect(body[0].cost).toBe(1);
    expect(typeof body[0].day).toBe('string');
  });

  it('is gated — a user not assigned to the project is forbidden (403)', async () => {
    const { app, taskUsage, bobTok } = setup();
    taskUsage.record('t1', 1, 'sonnet', usage);
    expect((await app.request('/usage/by-day', auth(bobTok))).status).toBe(403);
  });

  it('clamps ?days= to a sane window without erroring', async () => {
    const { app, taskUsage, adminTok } = setup();
    taskUsage.record('t1', 1, 'sonnet', usage);
    expect((await app.request('/usage/by-day?days=0', auth(adminTok))).status).toBe(200);
    expect((await app.request('/usage/by-day?days=99999', auth(adminTok))).status).toBe(200);
    expect((await app.request('/usage/by-day?days=notanumber', auth(adminTok))).status).toBe(200);
  });
});

/** The same server with NO owner for the usage snapshots — the shape of an instance whose work plugin is
 *  switched off. Disabling drops no table, so the rows are still there and a reset must still clear them.
 *  `taskRefs` is core's tolerant handle on those grandfathered tables. */
function setupWithoutOwner() {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const taskUsage = new RefTaskUsage(db);
  const tmux = new FakeTmuxDriver();
  const app = createServer({
    tasks: new RefTaskStore(db), readiness: new RefReadiness(db), missions: new RefMissions(db), bus: new EventBus(),
    engine: { disengage: async () => {} } as never, tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    taskRefs: new TaskRefs(db), brainStore: new BrainStore(db),
  });
  // Rows written through a store the SERVER does not hold: exactly what a disabled plugin leaves behind.
  return { app, db, taskUsage, adminTok: users.issueToken(admin.id) };
}

describe('POST /usage/reset', () => {
  it('clears the snapshots left behind by a disabled owner instead of reporting a cheerful zero', async () => {
    const { app, db, taskUsage, adminTok } = setupWithoutOwner();
    taskUsage.record('t1', 1, 'sonnet', usage);

    const res = await app.request('/usage/reset', post(adminTok));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, cleared: 1 });
    // The real proof: the rows are gone from the DB, not just absent from a store nobody was holding.
    expect((db.prepare('SELECT COUNT(*) AS n FROM task_usage').get() as { n: number }).n).toBe(0);
  });

  it('forbids a non-admin (403)', async () => {
    const { app, bobTok } = setup();
    expect((await app.request('/usage/reset', post(bobTok))).status).toBe(403);
  });

  it('wipes the snapshots and returns the count (admin)', async () => {
    const { app, taskUsage, adminTok } = setup();
    taskUsage.record('t1', 1, 'sonnet', usage);
    taskUsage.record('t2', 1, 'opus', usage);
    const res = await app.request('/usage/reset', post(adminTok));
    expect(res.status).toBe(200);
    // `chatCleared` is reported alongside the snapshot count: the charts sum both sources, so a reset
    // that only wiped snapshots left the page looking unchanged on a chat-heavy instance.
    // `originsCleared` is 0 here because this wiring holds no origin store — the counts stay separate so
    // a reset that missed one of the three sources is visible in the response instead of silently partial.
    expect(await res.json()).toEqual({ ok: true, cleared: 2, chatCleared: 0, originsCleared: 0 });
    expect(taskUsage.aggregateByExec()).toEqual([]);
  });
});

describe('GET /usage/by-day — brain session merge', () => {
  const seedBrain = (db: ReturnType<typeof openDb>, userId: number, costTotal: number | null) => {
    db.prepare("INSERT INTO brain_sessions (id, user_id, title, model) VALUES ('brain-1', ?, 't', 'm')").run(userId);
    const usage = { totalTokens: 500, ...(costTotal == null ? {} : { cost: { total: costTotal } }) };
    const content = JSON.stringify({ role: 'assistant', content: [], usage, timestamp: Date.now() });
    db.prepare("INSERT INTO brain_messages (id, session_id, role, content) VALUES ('m1', 'brain-1', 'assistant', ?)").run(content);
  };

  it("merges the caller's own brain-session spend into the daily buckets", async () => {
    const { app, db, taskUsage, adminId, adminTok } = setup();
    taskUsage.record('t1', 1, 'sonnet', usage);
    seedBrain(db, adminId, 0.25);
    const body = await (await app.request('/usage/by-day', auth(adminTok))).json();
    expect(body).toHaveLength(1);
    expect(body[0].tokens).toBe(165 + 500);
    expect(body[0].cost).toBeCloseTo(0.5 + 0.25);
  });

  it('keeps tasks-only semantics when a project_id filter is set (chat spend has no project)', async () => {
    const { app, db, taskUsage, adminId, adminTok } = setup();
    taskUsage.record('t1', 1, 'sonnet', usage);
    seedBrain(db, adminId, 0.25);
    const body = await (await app.request('/usage/by-day?project_id=1', auth(adminTok))).json();
    expect(body[0].tokens).toBe(165);
    expect(body[0].cost).toBe(0.5);
  });

  it('brain-only days appear even with no task usage, and cost stays null without reported costs', async () => {
    const { app, db, adminId, adminTok } = setup();
    seedBrain(db, adminId, null);
    const body = await (await app.request('/usage/by-day', auth(adminTok))).json();
    expect(body).toHaveLength(1);
    expect(body[0].tokens).toBe(500);
    expect(body[0].cost).toBeNull();
  });
});

describe('GET /usage/by-model — brain session merge', () => {
  const seedBrainModel = (db: ReturnType<typeof openDb>, userId: number, sessionId: string, model: string, totalTokens: number, cost: number | null, provider = '', messageProvider = provider) => {
    db.prepare("INSERT INTO brain_sessions (id, user_id, title, provider, model) VALUES (?, ?, 't', ?, ?)").run(sessionId, userId, provider, model);
    const u = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens, ...(cost == null ? {} : { cost: { total: cost } }) };
    const content = JSON.stringify({ role: 'assistant', content: [], ...(messageProvider ? { provider: messageProvider } : {}), model, usage: u, timestamp: Date.now() });
    db.prepare("INSERT INTO brain_messages (id, session_id, role, content) VALUES (?, ?, 'assistant', ?)").run(`${sessionId}-m1`, sessionId, content);
  };

  it('returns same-named brain models from different providers as distinct structured identities', async () => {
    const { app, db, adminId, adminTok } = setup();
    db.prepare("INSERT INTO brain_sessions (id, user_id, title, provider, model) VALUES ('brain-1', ?, 't', 'current', 'shared-model')").run(adminId);
    const append = (id: string, provider: string, totalTokens: number) => db.prepare(
      "INSERT INTO brain_messages (id, session_id, role, content) VALUES (?, 'brain-1', 'assistant', ?)"
    ).run(id, JSON.stringify({
      role: 'assistant', provider, model: 'shared-model', timestamp: Date.now(),
      usage: { input: 0, output: totalTokens, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens },
    }));
    append('m1', 'elowen-provider-a', 100);
    append('m2', 'elowen-provider-b', 200);

    const body = await (await app.request('/usage/by-model', auth(adminTok))).json();
    expect(body.map((r: { id: string; provider: string; model: string; usage: { total: number } }) =>
      [r.id, r.provider, r.model, r.usage.total])).toEqual([
      ['provider-a/shared-model', 'provider-a', 'shared-model', 100],
      ['provider-b/shared-model', 'provider-b', 'shared-model', 200],
    ]);
  });

  it("merges the caller's own chat spend as an elowen:<model> row alongside task rows", async () => {
    const { app, db, taskUsage, adminId, adminTok } = setup();
    taskUsage.record('t1', 1, 'sonnet', usage);
    seedBrainModel(db, adminId, 'brain-1', 'claude-opus-4-8', 300, 0.3);
    const body = await (await app.request('/usage/by-model', auth(adminTok))).json();
    const byExec = Object.fromEntries(body.map((r: { exec: string; usage: { total: number; costUsd: number | null } }) => [r.exec, r.usage]));
    expect(byExec['sonnet'].total).toBe(165);
    expect(byExec['elowen:claude-opus-4-8'].total).toBe(300);
    expect(byExec['elowen:claude-opus-4-8'].costUsd).toBeCloseTo(0.3);
  });

  it('folds chat + a task worker on the SAME model into one bucket, cost added once (no double count)', async () => {
    const { app, db, taskUsage, adminId, adminTok } = setup();
    // A task worker and chat on the same full embedded-brain identity must sum into one bucket.
    taskUsage.record('t1', 1, 'relay/claude-opus-4-8', { ...usage, total: 200, costUsd: 0.2 });
    seedBrainModel(db, adminId, 'brain-1', 'claude-opus-4-8', 300, 0.3, 'relay', 'elowen-relay');
    const body = await (await app.request('/usage/by-model', auth(adminTok))).json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 'relay/claude-opus-4-8', exec: 'relay/claude-opus-4-8', program: 'elowen', provider: 'relay', model: 'claude-opus-4-8' });
    expect(body[0].usage.total).toBe(500); // 200 task + 300 chat
    expect(body[0].usage.costUsd).toBeCloseTo(0.5); // 0.2 + 0.3, counted once
    expect(body[0].usage.costSource).toBe('provider_reported');
  });

  it('puts the MEASURED tok/s pair on the wire so a consumer can weight the average', async () => {
    const { app, db, taskUsage, adminId, adminTok } = setup();
    taskUsage.record('t1', 1, 'elowen:claude-opus-4-8', { ...usage, total: 200, costUsd: 0.2 }); // worker: no timing
    db.prepare("INSERT INTO brain_sessions (id, user_id, title, model) VALUES ('brain-1', ?, 't', 'claude-opus-4-8')").run(adminId);
    const assistant = (id: string, output: number, durationMs: number | null) =>
      db.prepare("INSERT INTO brain_messages (id, session_id, role, content) VALUES (?, 'brain-1', 'assistant', ?)").run(id, JSON.stringify({
        role: 'assistant', timestamp: Date.now(), ...(durationMs == null ? {} : { durationMs }),
        usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: output },
      }));
    assistant('m1', 1_000_000, null);   // legacy row, no timing → not measured
    assistant('m2', 10_000, 200_000);   // measured: 10k over 200 s → 50 tok/s
    const body = await (await app.request('/usage/by-model', auth(adminTok))).json();
    expect(body).toHaveLength(1);
    expect(body[0].usage.output).toBe(1_010_050);      // every output token, task worker's 50 included
    expect(body[0].usage.measuredOutput).toBe(10_000); // …but only the timed slice carries the speed
    expect(body[0].usage.outputTps).toBeCloseTo(50);
  });

  it('keeps tasks-only semantics under a project_id filter (chat spend has no project)', async () => {
    const { app, db, taskUsage, adminId, adminTok } = setup();
    taskUsage.record('t1', 1, 'sonnet', usage);
    seedBrainModel(db, adminId, 'brain-1', 'claude-opus-4-8', 300, 0.3);
    const body = await (await app.request('/usage/by-model?project_id=1', auth(adminTok))).json();
    expect(body).toHaveLength(1);
    expect(body[0].exec).toBe('sonnet');
  });

  it('excludes a brain-task chat session that already snapshotted to task_usage (no double count)', async () => {
    const { app, db, taskUsage, adminId, adminTok } = setup();
    seedBrainModel(db, adminId, 'brain-task-9', 'claude-opus-4-8', 999, 9.9);
    taskUsage.record('9', 1, 'elowen:claude-opus-4-8', { ...usage, total: 999, costUsd: 9.9 }); // healthy worker snapshot
    const body = await (await app.request('/usage/by-model', auth(adminTok))).json();
    // Only the task_usage snapshot survives; the chat rows are NOT re-counted on top of it.
    expect(body).toHaveLength(1);
    expect(body[0].exec).toBe('elowen:claude-opus-4-8');
    expect(body[0].usage.total).toBe(999);
  });

  it('KEEPS a crashed brain-task chat session that never snapshotted (spend not lost)', async () => {
    const { app, db, adminId, adminTok } = setup();
    seedBrainModel(db, adminId, 'brain-task-9', 'claude-opus-4-8', 40, 0.04); // no task_usage row → crashed worker
    const body = await (await app.request('/usage/by-model', auth(adminTok))).json();
    expect(body).toHaveLength(1);
    expect(body[0].exec).toBe('elowen:claude-opus-4-8');
    expect(body[0].usage.total).toBe(40); // crashed-worker spend surfaces as brain usage instead of vanishing
  });
});
